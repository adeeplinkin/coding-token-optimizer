/**
 * Stage 1R loopback **capture server** — a stand-in model provider for the request-mutation experiment.
 *
 * It exists so the influence question ("is a mutation made inside `ctx.session.hook("context")` sent to
 * the provider?") can be answered against a **real** outbound request without contacting any provider,
 * spending anything, or using a credential. It listens on loopback only, records what it receives, and
 * answers in the shape the runtime's provider protocol expects.
 *
 * Recording is deliberately raw and bounded: the captured file holds only what the runtime sent this
 * server. The experiment uses synthetic fixture content only, and the runtime's `--model` is pointed at
 * a provider whose `baseURL` is this server, so nothing else can reach it.
 *
 * Usage:
 *   node stage1r-capture-server.mjs --capture <file.jsonl> [--port 0] [--mode probe|scripted]
 *                                   [--read-path <abs path>] [--tool-turns 1]
 *
 * `--mode probe` records the request and answers `500`, which is enough to learn the exact path and
 * body shape. `--mode scripted` answers with one `read` tool call and then a final text answer, so a
 * session completes normally and a second request is assembled with the tool result in it.
 *
 * It prints `LISTENING <port>` once it is ready, so a caller can wait for readiness instead of
 * sleeping. It is not part of the product and is never loaded by a plugin.
 */
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = { capture: undefined, port: 0, mode: 'probe', readPath: '', toolTurns: 1 };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--capture') args.capture = value;
    else if (key === '--port') args.port = Number(value);
    else if (key === '--mode') args.mode = value;
    else if (key === '--read-path') args.readPath = value;
    else if (key === '--tool-turns') args.toolTurns = Number(value);
  }
  if (args.capture === undefined) {
    throw new Error('--capture <file.jsonl> is required');
  }
  return args;
}

const args = parseArgs(process.argv);
writeFileSync(args.capture, '');

/** Number of requests seen so far, which is what selects the scripted answer. */
let sequence = 0;

function record(request) {
  appendFileSync(args.capture, `${JSON.stringify(request)}\n`);
}

function readBody(httpRequest) {
  return new Promise((resolve) => {
    const chunks = [];
    httpRequest.on('data', (chunk) => chunks.push(chunk));
    httpRequest.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    httpRequest.on('error', () => resolve(''));
  });
}

function chatCompletion(content, toolCalls) {
  const message = { role: 'assistant', content };
  if (toolCalls !== undefined) {
    message.tool_calls = toolCalls;
  }
  return {
    id: `chatcmpl-stage1r-${sequence}`,
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'stage1r-mock',
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls === undefined ? 'stop' : 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

/** A streamed chat-completion answer, `data:` frames then `[DONE]`. */
function sseChatCompletion(res, content, toolCalls, includeUsage) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta, finishReason) =>
    `data: ${JSON.stringify({
      id: `chatcmpl-stage1r-${sequence}`,
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'stage1r-mock',
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    })}\n\n`;
  res.write(chunk({ role: 'assistant', content: content === null ? '' : content }, null));
  if (toolCalls !== undefined) {
    for (const call of toolCalls) {
      res.write(chunk({ tool_calls: [{ index: 0, ...call }] }, null));
    }
    res.write(chunk({}, 'tool_calls'));
  } else {
    res.write(chunk({}, 'stop'));
  }
  if (includeUsage) {
    // `stream_options.include_usage` asks for one final frame with no choices and the usage totals.
    res.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-stage1r-${sequence}`,
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'stage1r-mock',
        choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      })}\n\n`,
    );
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Decide the answer from the request **content**, not from a request counter, so a provider retry can
 * never advance the script: the first request has no `tool` message and gets the tool call; every
 * later request carries the tool result and gets the final text.
 */
function scriptedAnswer(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const sawToolResult = messages.some((message) => message?.role === 'tool');
  const streaming = parsed?.stream === true;
  const includeUsage = parsed?.stream_options?.include_usage === true;
  const toolTurns = messages.filter((message) => message?.role === 'assistant').length < args.toolTurns;
  if (!sawToolResult && toolTurns) {
    const call = {
      id: `call_stage1r_${sequence}`,
      type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path: args.readPath }) },
    };
    return { streaming, includeUsage, content: null, toolCalls: [call] };
  }
  return { streaming, includeUsage, content: 'DONE.', toolCalls: undefined };
}

const server = createServer(async (httpRequest, res) => {
  const body = await readBody(httpRequest);
  const current = sequence;
  sequence += 1;
  record({
    seq: current,
    at: new Date().toISOString(),
    method: httpRequest.method,
    url: httpRequest.url,
    headerNames: Object.keys(httpRequest.headers).sort(),
    contentType: httpRequest.headers['content-type'] ?? null,
    accept: httpRequest.headers['accept'] ?? null,
    bodyLength: body.length,
    body,
  });

  if (args.mode === 'probe') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'stage1r capture-only server', type: 'mock' } }));
    return;
  }

  const answer = scriptedAnswer(body);
  if (answer.streaming) {
    sseChatCompletion(res, answer.content, answer.toolCalls, answer.includeUsage);
    return;
  }
  const payload = chatCompletion(answer.content, answer.toolCalls);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
});

server.listen(args.port, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : args.port;
  process.stdout.write(`LISTENING ${port}\n`);
});
