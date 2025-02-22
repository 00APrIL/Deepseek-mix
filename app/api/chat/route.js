import { NextResponse } from 'next/server';

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
  base_LLM_authkey: "sk-L76IUw7s8Dcu4ybu9pzjatr21oBTn7ucgZenmsTCGv0QfeA1", // 在这里填入你的 OpenAI API Key
  base_model: "claude-3-5-sonnet-all",

  // 推理模型设定
  thinking_model: "deepseek-ai/DeepSeek-R1",
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
  new NextResponse(null, {
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
 */
const fetchWithRetries = async (url, options) => {
  const maxRetries = userConfig.fetch_max_retries;
  let attempt = 0;
  let response = null;
  while (attempt <= maxRetries) {
    response = await fetch(url, options);
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
 * ===============================
 */
const openai_messages_normalizer = (reqBody) => {
  const normalized = { ...reqBody };
  let messages = Array.isArray(normalized.messages) ? normalized.messages : [];

  if (messages.length === 0 || messages[0].role !== "system") {
    messages.unshift({ role: "system", content: userConfig.default_sys_prompt });
  }
  if (messages[messages.length - 1]?.role !== "user") {
    messages.push({ role: "user", content: userConfig.default_end_prompt });
  }

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
 * 生成 OpenAI 格式的 chat 补全 ID
 * ===============================
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
 * 构造 SSE 消息数据块
 * ===============================
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
 * 构造基础模型请求体
 * ===============================
 */
const buildThoughtfulRequest = (normalizedRequest, truncatedContent) => {
  const requestBody = structuredClone(normalizedRequest);
  const tag = userConfig.xmlSystemTag;
  const originalSystem = requestBody.messages[0].content;
  requestBody.messages[0].content = `<${tag}>${originalSystem}</${tag}>\n${truncatedContent}`;
  const introText = userConfig.introThought;
  const lastIndex = requestBody.messages.length - 1;
  requestBody.messages[lastIndex].content = introText + requestBody.messages[lastIndex].content;
  requestBody.model = userConfig.base_model;
  return requestBody;
};

/**
 * ===============================
 * 调用基础模型接口
 * ===============================
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
 * SSE 事件生成器
 * ===============================
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
 * 处理思考模型的 SSE 流
 * ===============================
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
 * 流式请求处理
 * ===============================
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
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(thinkingRequest),
    });
  } catch (err) {
    return new NextResponse(
      JSON.stringify({
        error: "Error contacting thinking model",
        details: err.toString(),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
  if (thinkingResponse.status !== 200) return thinkingResponse;

  if (userConfig.showThinking) {
    const stream = new ReadableStream({
      async start(controller) {
        const truncated = await processThinkingStream(
          thinkingResponse.body.getReader(),
          controller
        );
        userConfig.debug && console.log("思考模型截断内容:", truncated);
        controller.enqueue(new TextEncoder().encode(createSSEChunk("\n\n")));

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
    });

    return new NextResponse(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  } else {
    const truncated = await processThinkingStream(thinkingResponse.body.getReader());
    userConfig.debug && console.log("思考模型截断内容:", truncated);
    const baseRequest = buildThoughtfulRequest(normalized, truncated);
    userConfig.debug &&
      console.log("基础模型请求体:", JSON.stringify(baseRequest, null, 2));
    return fetchBaseModel(baseRequest);
  }
};

/**
 * ===============================
 * SSE to delta content TransformStream
 * ===============================
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
 * 非流式请求处理
 * ===============================
 */
const handleNonStreamRequest = async (clientReqPayload, token) => {
  clientReqPayload.stream = true;
  const streamResponse = await handleStreamRequest(clientReqPayload, token);
  if (streamResponse.status !== 200) return streamResponse;

  const id = generateChatcmplId();
  const headerChunk = `{"id":"${id}","object":"chat.completion","created":${Math.floor(
    Date.now() / 1000
  )},"model":"${userConfig.base_model}","choices":[{"index":0,"message":{"role":"assistant","content
