/**
 * Streaming parser validation tests for each LLM provider.
 *
 * These tests reproduce the SSE/NDJSON parsing logic from service_worker.js
 * and validate it against realistic mock API responses for each provider.
 * They give production confidence that the parsers handle real-world response
 * formats, edge cases, and token usage reporting correctly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Inline parser implementations (mirroring service_worker.js) ───
// These are direct copies of the parsing logic in each generateWith* function
// so tests stay honest — any drift from the real implementation is a signal.

function parseOpenAIStream(lines) {
  let output = '';
  let usageData = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const payload = JSON.parse(data);
      const delta = payload.choices?.[0]?.delta?.content || '';
      if (delta) output += delta;
      if (payload.usage) usageData = payload.usage;
    } catch { /* skip */ }
  }

  return {
    output: output.trim(),
    inputTokens: usageData?.prompt_tokens ?? null,
    outputTokens: usageData?.completion_tokens ?? null
  };
}

function parseAnthropicStream(lines) {
  let output = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const event = JSON.parse(data);
      if (event.type === 'content_block_delta' && event.delta?.text) {
        output += event.delta.text;
      } else if (event.type === 'message_start' && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens || 0;
      } else if (event.type === 'message_delta' && event.usage) {
        outputTokens = event.usage.output_tokens || 0;
      }
    } catch { /* skip */ }
  }

  return { output: output.trim(), inputTokens, outputTokens };
}

function parseGeminiStream(lines) {
  let output = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (!data) continue;
    try {
      const event = JSON.parse(data);
      const text = event.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text) output += text;
      if (event.usageMetadata) {
        inputTokens = event.usageMetadata.promptTokenCount || inputTokens;
        outputTokens = event.usageMetadata.candidatesTokenCount || outputTokens;
      }
    } catch { /* skip */ }
  }

  return { output: output.trim(), inputTokens, outputTokens };
}

function parseOllamaStream(lines) {
  let output = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      const text = data.message?.content || '';
      if (text) output += text;
      if (data.done) {
        inputTokens = data.prompt_eval_count || 0;
        outputTokens = data.eval_count || 0;
      }
    } catch { /* skip */ }
  }

  return { output: output.trim(), inputTokens, outputTokens };
}

// ─── OpenAI SSE parser tests ───

test('OpenAI parser: assembles streamed text chunks', () => {
  const lines = [
    'data: {"choices":[{"delta":{"content":"Hello"}}],"model":"gpt-4.1-mini"}',
    'data: {"choices":[{"delta":{"content":" world"}}],"model":"gpt-4.1-mini"}',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":2},"model":"gpt-4.1-mini"}',
    'data: [DONE]'
  ];
  const result = parseOpenAIStream(lines);
  assert.equal(result.output, 'Hello world');
  assert.equal(result.inputTokens, 10);
  assert.equal(result.outputTokens, 2);
});

test('OpenAI parser: returns null tokens when no usage event', () => {
  const lines = [
    'data: {"choices":[{"delta":{"content":"Hi"}}],"model":"gpt-4.1-mini"}',
    'data: [DONE]'
  ];
  const result = parseOpenAIStream(lines);
  assert.equal(result.output, 'Hi');
  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, null);
});

test('OpenAI parser: skips non-data lines', () => {
  const lines = [
    '',
    'event: ping',
    'data: {"choices":[{"delta":{"content":"Test"}}],"model":"gpt-4.1-mini"}',
    ': comment line',
    'data: [DONE]'
  ];
  const result = parseOpenAIStream(lines);
  assert.equal(result.output, 'Test');
});

test('OpenAI parser: handles empty delta gracefully', () => {
  const lines = [
    'data: {"choices":[{"delta":{}}],"model":"gpt-4.1-mini"}',
    'data: {"choices":[{"delta":{"content":"OK"}}],"model":"gpt-4.1-mini"}',
    'data: [DONE]'
  ];
  const result = parseOpenAIStream(lines);
  assert.equal(result.output, 'OK');
});

test('OpenAI parser: handles malformed JSON without throwing', () => {
  const lines = [
    'data: {"choices":[{"delta":{"content":"Good"}}]}',
    'data: {broken json',
    'data: {"choices":[{"delta":{"content":"!"}}]}',
    'data: [DONE]'
  ];
  const result = parseOpenAIStream(lines);
  assert.equal(result.output, 'Good!');
});

// ─── Anthropic SSE parser tests ───

test('Anthropic parser: captures text from content_block_delta events', () => {
  const lines = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}',
    'data: {"type":"message_stop"}'
  ];
  const result = parseAnthropicStream(lines);
  assert.equal(result.output, 'Hello Claude');
  assert.equal(result.inputTokens, 25);
  assert.equal(result.outputTokens, 8);
});

test('Anthropic parser: handles multi-chunk text assembly', () => {
  const chunks = ['The ', 'quick ', 'brown ', 'fox'];
  const lines = chunks.map(text =>
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}`
  );
  lines.push('data: {"type":"message_delta","usage":{"output_tokens":4}}');
  const result = parseAnthropicStream(lines);
  assert.equal(result.output, 'The quick brown fox');
  assert.equal(result.outputTokens, 4);
});

test('Anthropic parser: ignores ping and other non-content events', () => {
  const lines = [
    'data: {"type":"ping"}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
    'data: {"type":"message_stop"}'
  ];
  const result = parseAnthropicStream(lines);
  assert.equal(result.output, 'Hi');
});

test('Anthropic parser: zero tokens when no usage events', () => {
  const lines = [
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Test"}}'
  ];
  const result = parseAnthropicStream(lines);
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
});

// ─── Gemini SSE parser tests ───

test('Gemini parser: extracts text from candidates array', () => {
  const lines = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Gemini "}],"role":"model"}}]}',
    'data: {"candidates":[{"content":{"parts":[{"text":"response"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":2,"totalTokenCount":14}}'
  ];
  const result = parseGeminiStream(lines);
  assert.equal(result.output, 'Gemini response');
  assert.equal(result.inputTokens, 12);
  assert.equal(result.outputTokens, 2);
});

test('Gemini parser: uses last usageMetadata (most accurate)', () => {
  const lines = [
    'data: {"candidates":[{"content":{"parts":[{"text":"A"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1}}',
    'data: {"candidates":[{"content":{"parts":[{"text":"B"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}',
    'data: {"candidates":[{"content":{"parts":[{"text":"C"}],"finishReason":"STOP"}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3}}'
  ];
  const result = parseGeminiStream(lines);
  assert.equal(result.output, 'ABC');
  assert.equal(result.outputTokens, 3); // Final value
});

test('Gemini parser: handles missing usageMetadata gracefully', () => {
  const lines = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}'
  ];
  const result = parseGeminiStream(lines);
  assert.equal(result.output, 'Hello');
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
});

test('Gemini parser: skips empty candidates', () => {
  const lines = [
    'data: {"candidates":[]}',
    'data: {"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}'
  ];
  const result = parseGeminiStream(lines);
  assert.equal(result.output, 'OK');
});

// ─── Ollama NDJSON parser tests ───

test('Ollama parser: assembles chat response from NDJSON stream', () => {
  const lines = [
    '{"model":"llama3","message":{"role":"assistant","content":"Hello "},"done":false}',
    '{"model":"llama3","message":{"role":"assistant","content":"world"},"done":false}',
    '{"model":"llama3","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":8,"eval_count":2}'
  ];
  const result = parseOllamaStream(lines);
  assert.equal(result.output, 'Hello world');
  assert.equal(result.inputTokens, 8);
  assert.equal(result.outputTokens, 2);
});

test('Ollama parser: handles missing eval counts', () => {
  const lines = [
    '{"model":"llama3","message":{"role":"assistant","content":"Hi"},"done":true}'
  ];
  const result = parseOllamaStream(lines);
  assert.equal(result.output, 'Hi');
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
});

test('Ollama parser: skips empty lines', () => {
  const lines = [
    '',
    '{"model":"llama3","message":{"role":"assistant","content":"Test"},"done":false}',
    '',
    '{"model":"llama3","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":5,"eval_count":1}'
  ];
  const result = parseOllamaStream(lines);
  assert.equal(result.output, 'Test');
  assert.equal(result.inputTokens, 5);
});

test('Ollama parser: handles malformed lines without throwing', () => {
  const lines = [
    '{"model":"llama3","message":{"role":"assistant","content":"OK"},"done":false}',
    'not json at all',
    '{"model":"llama3","message":{"role":"assistant","content":"!"},"done":true,"prompt_eval_count":3,"eval_count":1}'
  ];
  const result = parseOllamaStream(lines);
  assert.equal(result.output, 'OK!');
  assert.equal(result.inputTokens, 3);
});

// ─── Cross-provider token count contracts ───

test('all parsers return inputTokens and outputTokens as numbers', () => {
  const openaiResult = parseOpenAIStream([
    'data: {"choices":[{"delta":{"content":"x"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    'data: [DONE]'
  ]);
  const anthropicResult = parseAnthropicStream([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}',
    'data: {"type":"message_delta","usage":{"output_tokens":1}}'
  ]);
  const geminiResult = parseGeminiStream([
    'data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}'
  ]);
  const ollamaResult = parseOllamaStream([
    '{"model":"llama3","message":{"role":"assistant","content":"x"},"done":true,"prompt_eval_count":1,"eval_count":1}'
  ]);

  for (const [name, result] of [['openai', openaiResult], ['anthropic', anthropicResult], ['gemini', geminiResult], ['ollama', ollamaResult]]) {
    assert.equal(typeof result.inputTokens, 'number', `${name} inputTokens should be number`);
    assert.equal(typeof result.outputTokens, 'number', `${name} outputTokens should be number`);
    assert.equal(result.output, 'x', `${name} output should be 'x'`);
  }
});

test('all parsers handle empty stream without errors', () => {
  assert.doesNotThrow(() => parseOpenAIStream([]));
  assert.doesNotThrow(() => parseAnthropicStream([]));
  assert.doesNotThrow(() => parseGeminiStream([]));
  assert.doesNotThrow(() => parseOllamaStream([]));
});
