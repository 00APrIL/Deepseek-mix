/**
 * ===============================
 * 用户配置 - 请根据实际环境修改各项参数
 * ===============================
 */
const userConfig = {
  // 通用设定
  debug: true, // 调试开关，设置为 true 时会输出调试信息
  showThinking: true, // 当为 true 时，流式传输 thinking_LLM 的响应给客户端
  fetch_max_retries: 20, // 网络请求最大重试次数

  // 基础模型设定 - OpenAI 格式
  base_LLM_url: "https://aizex.top",
  base_LLM_authkey: "sk-L76IUw7s8Dcu4ybu9pzjatr21oBTn7ucgZenmsTCGv0QfeA1", // (Note: double-check this value)
  base_model: "claude-3-5-sonnet-all",

  // 推理模型设定 - 兼容 "reasoning_content" 字段 和 "<think>"标记 的思考过程
  // Providers: Azure AI / Together.ai / Nvidia NIM / etc.
  thinking_model: "deepseek-ai/DeepSeek-R1", // "deepseek-ai/DeepSeek-R1", "deepseek-ai/deepseek-r1"
  thinking_LLM_url: "https://api.siliconflow.cn/v1/chat/completions", 

  // 提示工程设定
  xmlSystemTag: "instruction",
  thinking_LLM_truncator: "</think>",
  thinking_LLM_prefix: 
    "Initiate your thoughts with a instance of \"<think>\n\n\" at the beginning of every reasoning",
  thinking_LLM_suffix: "\n</think>",
  introThought: 
    "[proceeding as instructed in <think>]\n",
  default_sys_prompt: "You are a helpful assistant.",
  default_end_prompt: "continue",
};


/**
 * ===============================
 * CORS OPTIONS 响应处理
 * ===============================
 */
const handleOPTIONS = async () =>
  new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    },
  });

/**
 * ===============================
 * 带重试机制的 fetch 封装
 * ===============================
 *
 * @param {string} url 请求 URL
 * @param {object} options fetch 配置项
 * @returns {Promise<Response>}
 */
const fetchWithRetries = async (url, options) => {
  const maxRetries = userConfig.fetch_max_retries;
  let attempt = 0;
  let response = null;
  while (attempt <= maxRetries) {
    response = await fetch(url, options);
    // 对于非 5xx 响应直接返回
    if (response.status < 500 || response.status >= 600) {
      return response;
    }
    attempt++;
  }
  return response;
};

/**
 * ===============================
 * 标准化消息请求
 * 1. 保证第一条消息为 system 消息（若不存在则插入默认 system 消息）
 * 2. 保证最后一条消息为 user 消息（若不存在则追加默认 user 消息）
 * 3. 若消息内容中包含 thinking_LLM_truncator，则仅保留截断标记后的内容
 * ===============================
 *
 * @param {object} reqBody 请求体
 * @returns {object} 标准化后的请求体
 */
const openai_messages_normalizer = (reqBody) => {
  const normalized = { ...reqBody };
  let messages = Array.isArray(normalized.messages) ? normalized.messages : [];

  // 如果第一条消息不是 system 则添加默认 system 消息
  if (messages.length === 0 || messages[0].role !== "system") {
    messages.unshift({ role: "system", content: userConfig.default_sys_prompt });
  }
  // 如果最后一条消息不是 user，则追加默认 user 消息
  if (messages[messages.length - 1]?.role !== "user") {
    messages.push({ role: "user", content: userConfig.default_end_prompt });
  }

  // 检查各消息是否包含截断标记，如有则仅保留截断标记后的内容
  messages = messages.map((msg) => {
    if (typeof msg.content === "string") {
      const idx = msg.content.indexOf(userConfig.thinking_LLM_truncator);
      if (idx !== -1) {
        msg.content = msg.content
          .substring(idx + userConfig.thinking_LLM_truncator.length)
          .replace(/^[\n\r]+/, "");
      }
    }
    return msg;
  });

  normalized.messages = messages;
  userConfig.debug && console.log("标准化后的请求体:", normalized);
  return normalized;
};

/**
 * ===============================
 * 生成 OpenAI 格式的 chat 补全 ID（随机字符串）
 * ===============================
 *
 * @returns {string} chat 补全 ID
 */
const generateChatcmplId = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return (
    "chatcmpl-" +
    Array.from({ length: 29 }, () => chars[Math.floor(Math.random() * chars.length)]).join("")
  );
};

/**
 * ===============================
 * 根据 delta 内容构造 SSE 消息数据块（符合 OpenAI 格式）
 * ===============================
 *
 * @param {string} deltaContent SSE 消息中的 delta 内容
 * @returns {string} SSE 数据字符串
 */
const createSSEChunk = (deltaContent) =>
  "data: " +
  JSON.stringify({
    id: generateChatcmplId(),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: userConfig.thinking_model,
    choices: [
      {
        delta: { content: deltaContent },
        index: 0,
        finish_reason: null,
      },
    ],
  }) +
  "\n\n";

/**
 * ===============================
 * 构造增强后的基础模型请求体
 * 1. 将 system 消息封装为包含思考模型截断后的内容
 * 2. 对 user 消息前置引导文本，提示基础模型参考思考过程
 * ===============================
 *
 * @param {object} normalizedRequest 标准化后的请求体
 * @param {string} truncatedContent 思考模型截断的内容
 * @returns {object} 构造后基础模型的请求体
 */
const buildThoughtfulRequest = (normalizedRequest, truncatedContent) => {
  const requestBody = structuredClone(normalizedRequest);
  const tag = userConfig.xmlSystemTag;
  const originalSystem = requestBody.messages[0].content;
  requestBody.messages[0].content = `<${tag}>${originalSystem}</${tag}>\n${truncatedContent}`;
  // 在最后一条 user 消息前添加引导文本
  const introText = userConfig.introThought;
  const lastIndex = requestBody.messages.length - 1;
  requestBody.messages[lastIndex].content = introText + requestBody.messages[lastIndex].content;
  requestBody.model = userConfig.base_model;
  return requestBody;
};

/**
 * ===============================
 * 调用基础模型接口发送请求
 * ===============================
 *
 * @param {object} requestBody 基础模型请求体
 * @returns {Promise<Response>}
 */
const fetchBaseModel = async (requestBody) => {
  try {
    return await fetchWithRetries(userConfig.base_LLM_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userConfig.base_LLM_authkey}`,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    throw new Error("Error contacting base model: " + err.toString());
  }
};

/**
 * ===============================
 * SSE 事件生成器：从流数据中提取完整 SSE 事件（以两个换行符为分隔）
 * ===============================
 *
 * @param {ReadableStreamDefaultReader} reader SSE 流的读取器
 * @yields {object} SSE 事件对象
 */
async function* sseEventIterator(reader) {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }
    const parts = buffer.split("\n\n");
    buffer = parts.pop();
    for (const part of parts) {
      if (part.startsWith("data: ")) {
        const dataStr = part.slice("data: ".length).trim();
        if (dataStr) {
          try {
            yield JSON.parse(dataStr);
          } catch (e) {
            console.error("Error parsing SSE event:", e);
          }
        }
      }
    }
    if (done) break;
  }
  // 处理流末尾残留的数据
  if (buffer.trim().startsWith("data: ")) {
    const dataStr = buffer.trim().slice("data: ".length).trim();
    if (dataStr) {
      try {
        yield JSON.parse(dataStr);
      } catch (e) {
        console.error("Error parsing final SSE chunk:", e);
      }
    }
  }
}

/**
 * ===============================
 * 处理思考模型的 SSE 流，并返回累积后的截断内容
 * 如传入 controller，则实时将 chunk 传输给客户端
 * ===============================
 *
 * @param {ReadableStreamDefaultReader} reader SSE 流的读取器
 * @param {ReadableStreamDefaultController} [controller=null] 可选：客户端控制器
 * @returns {Promise<string>} 累积的截断内容
 */
const processThinkingStream = async (reader, controller = null) => {
  const encoder = new TextEncoder();
  let accumulated = "";
  let isPrevReasoningContent = false;

  for await (const event of sseEventIterator(reader)) {
    const deltaObj = event?.choices?.[0]?.delta || {};
    let deltaText = "";
    let isThisReasoningContent = false;

    if (
      deltaObj.hasOwnProperty("reasoning_content") &&
      deltaObj.reasoning_content !== null
    ) {
      deltaText = deltaObj.reasoning_content;
      isThisReasoningContent = true;
      if (!isPrevReasoningContent && controller) {
        controller.enqueue(encoder.encode(createSSEChunk("<think>\n")));
      }
    } else {
      deltaText = deltaObj.content || "";
    }
    accumulated += deltaText;
    const reasoningEnd = isPrevReasoningContent && !isThisReasoningContent;
    if (controller && !reasoningEnd) {
      controller.enqueue(encoder.encode(createSSEChunk(deltaText)));
    }
    if (reasoningEnd || accumulated.includes(userConfig.thinking_LLM_truncator)) {
      if (reasoningEnd && controller) {
        controller.enqueue(encoder.encode(createSSEChunk(userConfig.thinking_LLM_suffix)));
      }
      const truncIndex = accumulated.indexOf(userConfig.thinking_LLM_truncator);
      return truncIndex !== -1
        ? accumulated.slice(0, truncIndex + userConfig.thinking_LLM_truncator.length)
        : "<think>" + accumulated + "</think>";
    }
    isPrevReasoningContent = isThisReasoningContent;
  }

  return "<think>" + accumulated + "</think>";
};

/**
 * ===============================
 * 将 SSE 流转换为 delta 内容文本的 TransformStream
 * 输出经过 JSON.stringify 转义后的片段（去除首尾引号）
 * ===============================
 *
 * @returns {TransformStream}
 */
function createSSEToDeltaContentTransformStream() {
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const part of parts) {
        if (part.startsWith("data: ")) {
          const dataStr = part.slice(6).trim();
          if (dataStr && dataStr !== "[DONE]") {
            try {
              const event = JSON.parse(dataStr);
              const deltaContent = event?.choices?.[0]?.delta?.content;
              if (typeof deltaContent === "string") {
                // 使用 JSON.stringify 转义后去除首尾引号
                const escaped = JSON.stringify(deltaContent);
                controller.enqueue(escaped.slice(1, -1));
              }
            } catch (e) {
              console.error("Error parsing SSE event in transform stream:", e);
            }
          }
        }
      }
    },
    flush(controller) {
      if (buffer && buffer.startsWith("data: ")) {
        const dataStr = buffer.slice(6).trim();
        if (dataStr && dataStr !== "[DONE]") {
          try {
            const event = JSON.parse(dataStr);
            const deltaContent = event?.choices?.[0]?.delta?.content;
            if (typeof deltaContent === "string") {
              const escaped = JSON.stringify(deltaContent);
              controller.enqueue(escaped.slice(1, -1));
            }
          } catch (e) {
            console.error("Error parsing final SSE event in flush:", e);
          }
        }
      }
    },
  });
}

/**
 * ===============================
 * 流式请求处理
 * 1. 调用 thinking 模型获取 SSE 流
 * 2. 根据截断内容构造基础模型请求，并转发基础模型 SSE 流给客户端
 * ===============================
 *
 * @param {object} clientReqPayload 客户端请求负载
 * @param {string} token 客户端提供的 Authorization token
 * @returns {Promise<Response>}
 */
const handleStreamRequest = async (clientReqPayload, token) => {
  const normalized = openai_messages_normalizer(clientReqPayload);
  const thinkingRequest = structuredClone(normalized);
  thinkingRequest.model = userConfig.thinking_model;
  thinkingRequest.messages[0].content =
    userConfig.thinking_LLM_prefix + thinkingRequest.messages[0].content;

  let thinkingResponse;
  try {
    thinkingResponse = await fetchWithRetries(userConfig.thinking_LLM_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 使用客户端 Authorization 提供的 token
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(thinkingRequest),
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Error contacting thinking model",
        details: err.toString(),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
  if (thinkingResponse.status !== 200) return thinkingResponse;

  if (userConfig.showThinking) {
    return new Response(
      new ReadableStream({
        async start(controller) {
          // 第一阶段：实时转发 thinking 模型 SSE 流同时累积截断内容
          const truncated = await processThinkingStream(
            thinkingResponse.body.getReader(),
            controller
          );
          userConfig.debug && console.log("思考模型截断内容:", truncated);
          // 插入额外 SSE 消息（符合 OpenAI 格式）
          controller.enqueue(new TextEncoder().encode(createSSEChunk("\n\n")));

          // 第二阶段：构造基础模型请求，并转发基础模型 SSE 流
          const baseRequest = buildThoughtfulRequest(normalized, truncated);
          userConfig.debug &&
            console.log("基础模型请求体:", JSON.stringify(baseRequest, null, 2));
          try {
            const baseRes = await fetchBaseModel(baseRequest);
            const baseReader = baseRes.body.getReader();
            while (true) {
              const { value, done } = await baseReader.read();
              if (done) break;
              controller.enqueue(value);
            }
          } catch (err) {
            controller.error(
              new TextEncoder().encode(
                JSON.stringify({
                  error: "Error contacting base model",
                  details: err.toString(),
                })
              )
            );
          }
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  } else {
    // 静默模式：等待 thinking 模型处理完成后再调用基础模型
    const truncated = await processThinkingStream(
      thinkingResponse.body.getReader()
    );
    userConfig.debug && console.log("思考模型截断内容:", truncated);
    const baseRequest = buildThoughtfulRequest(normalized, truncated);
    userConfig.debug &&
      console.log("基础模型请求体:", JSON.stringify(baseRequest, null, 2));
    return fetchBaseModel(baseRequest);
  }
};

/**
 * ===============================
 * 非流式请求处理
 * 将 SSE 流数据转换为一次性返回的 JSON 字符串
 * ===============================
 *
 * @param {object} clientReqPayload 客户端请求负载
 * @param {string} token 客户端提供的 Authorization token
 * @returns {Promise<Response>}
 */
const handleNonStreamRequest = async (clientReqPayload, token) => {
  // 强制转为流式请求
  clientReqPayload.stream = true;
  const streamResponse = await handleStreamRequest(clientReqPayload, token);
  if (streamResponse.status !== 200) return streamResponse;

  // 构造最终 JSON 输出需要添加 header 与 footer
  const id = generateChatcmplId();
  const headerChunk = `{"id":"${id}","object":"chat.completion","created":${Math.floor(
    Date.now() / 1000
  )},"model":"${userConfig.base_model}","choices":[{"index":0,"message":{"role":"assistant","content":"`;
  const footerChunk = `","finish_reason":"stop"}}],"usage":{"prompt_tokens":9,"completion_tokens":12,"total_tokens":21}}`;

  // 通过管道转换 SSE 为 delta 文本：利用 TextDecoderStream、TransformStream 及 TextEncoderStream
  const transformedStream = streamResponse.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(createSSEToDeltaContentTransformStream())
    .pipeThrough(new TextEncoderStream());

  // 生成最终流，依次输出 header -> 转换后的内容 -> footer
  const finalStream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(headerChunk));
      const reader = transformedStream.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // value 已经为 Uint8Array
        controller.enqueue(value);
      }
      controller.enqueue(encoder.encode(footerChunk));
      controller.close();
    },
  });

  return new Response(finalStream, { headers: { "Content-Type": "application/json" } });
};

/**
 * ===============================
 * 主请求处理函数
 * ===============================
 *
 * @param {Request} request 请求对象
 * @returns {Promise<Response>}
 */
const handleRequest = async (request) => {
  if (request.method === "OPTIONS") return handleOPTIONS();

  // ---------------------------
  // 验证客户端身份：要求存在 Authorization header 且格式为 Bearer {token}
  // ---------------------------
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({ error: "Unauthorized: Missing Authorization header" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
  const token = authHeader.slice("Bearer ".length).trim();

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST is allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let clientRequestPayload;
  try {
    clientRequestPayload = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  return clientRequestPayload.stream === true
    ? await handleStreamRequest(clientRequestPayload, token)
    : await handleNonStreamRequest(clientRequestPayload, token);
};

/**
 * ===============================
 * 环境兼容处理
 * 支持 Deno、Vercel Edge、Cloudflare Workers/Pages、Node.js 等环境
 * ===============================
 */
(async () => {
  const port =
    typeof Deno !== "undefined"
      ? Deno.env.get("PORT") || 8000
      : process?.env?.PORT || 8000;

  if (typeof Deno !== "undefined") {
    console.log(`Listening on http://localhost:${port}`);
    return Deno.serve({ port }, handleRequest);
  }
  if (typeof EdgeRuntime !== "undefined" || typeof addEventListener === "function") {
    // Vercel Edge 与 Cloudflare Workers 环境
    return;
  }
  const { serve } = await import("@hono/node-server");
  console.log(`Listening on http://localhost:${port}`);
  serve({ fetch: handleRequest, port });
})();

/**
 * ===============================
 * 各环境导出定义
 * ===============================
 */

// Vercel Edge Serverless 配置
export const config = {
  runtime: "edge",
  regions: ["sfo1"],
};
export const GET = handleRequest;
export const POST = handleRequest;
export const OPTIONS = handleRequest;

// Cloudflare Pages Function
export function onRequest({ request }) {
  return handleRequest(request);
}

// Cloudflare Workers Function
export default {
  fetch: (req) => handleRequest(req),
};
