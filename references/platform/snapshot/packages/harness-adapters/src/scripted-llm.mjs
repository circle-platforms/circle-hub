// Scripted LLM stub: an OpenAI-compatible chat-completions endpoint
// that plays a fixed plan (JSON file named by SCRIPTED_LLM_PLAN):
//   steps: [ { "tool": "<tool name>", "arguments": {...} },
//            { "text": "final answer" } ]
// Each incoming request consumes the next step. Tool names in the
// plan are matched loosely: a step names the SUFFIX (e.g.
// "task_submit") and the stub picks the actual tool from the
// request's own tool list whose name ends with that suffix — harness
// namespacing differences stay visible in the request log instead of
// being papered over.
//
// Every request is appended to SCRIPTED_LLM_LOG as JSONL for evidence.
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";

const planPath = process.env.SCRIPTED_LLM_PLAN;
const logPath = process.env.SCRIPTED_LLM_LOG;
const port = Number(process.env.SCRIPTED_LLM_PORT ?? "17931");
const plan = planPath ? JSON.parse(readFileSync(planPath, "utf8")) : { steps: [] };
let stepIndex = 0;

function log(entry) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function pickTool(tools, suffix) {
  const names = (tools ?? []).map((t) => t.function?.name ?? t.name);
  return names.find((n) => n === suffix) ?? names.find((n) => n.endsWith(suffix)) ?? suffix;
}

function completion(step, tools) {
  const message = { role: "assistant", content: "" };
  let finish = "stop";
  if (step.tool) {
    const name = pickTool(tools, step.tool);
    message.content = null;
    message.tool_calls = [
      {
        id: `call_${stepIndex}`,
        type: "function",
        function: { name, arguments: JSON.stringify(step.arguments ?? {}) },
      },
    ];
    finish = "tool_calls";
    log({ event: "tool-call-issued", step: stepIndex, tool: name });
  } else {
    message.content = step.text ?? "done";
    log({ event: "text-issued", step: stepIndex });
  }
  return {
    id: `chatcmpl-scripted-${stepIndex}`,
    object: "chat.completion",
    created: 1_700_000_000,
    model: "scripted-1",
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function sseChunks(body) {
  const msg = body.choices[0].message;
  const base = {
    id: body.id,
    object: "chat.completion.chunk",
    created: body.created,
    model: body.model,
  };
  const chunks = [];
  if (msg.tool_calls) {
    const tc = msg.tool_calls[0];
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              { index: 0, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: tc.function.arguments } }] },
          finish_reason: null,
        },
      ],
    });
  } else {
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: msg.content }, finish_reason: null }],
    });
  }
  chunks.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: body.choices[0].finish_reason }],
  });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      // keep empty
    }
    const hasTools = (body.tools ?? []).length > 0;
    log({
      event: "request",
      step: stepIndex,
      stream: body.stream === true,
      toolNames: (body.tools ?? []).map((t) => t.function?.name ?? t.name),
      messageRoles: (body.messages ?? []).map((m) => m.role),
    });
    // Harnesses make auxiliary tool-less calls (titles, summaries).
    // Those never consume plan steps; only tool-bearing requests do.
    const step = hasTools
      ? (plan.steps[stepIndex] ?? { text: "plan exhausted" })
      : { text: "ok" };
    if (hasTools) stepIndex += 1;
    const responseBody = completion(step, body.tools);
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sseChunks(responseBody));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responseBody));
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`scripted-llm listening on 127.0.0.1:${port}`);
});
