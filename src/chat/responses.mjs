import { pathWithin, relativePath } from '../authority.mjs';

const providers = new Map([
  ['openai-responses', {
    name: 'OpenAI', endpoint: 'https://api.openai.com/v1/responses', options: { store: false },
  }],
  ['deepseek-responses', {
    name: 'DeepSeek', endpoint: 'https://api.deepseek.com/responses', options: { reasoning: { effort: 'none' } },
  }],
]);

export function discussionBackend(provider) {
  const backend = providers.get(provider);
  if (!backend) throw new Error(`chatting_agent.provider 应为 ${[...providers.keys()].join(' 或 ')}`);
  return backend;
}

const fields = {
  goal: { type: 'string' },
  approach: { type: 'string' },
  constraints: { type: 'array', items: { type: 'string' } },
  non_goals: { type: 'array', items: { type: 'string' } },
  acceptance_criteria: { type: 'array', items: { type: 'string' } },
  suggested_paths: { type: 'array', items: { type: 'string' } },
  questions: { type: 'array', items: { type: 'string' } },
};
const format = {
  type: 'json_schema', name: 'cccp_task_draft', strict: true,
  schema: { type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false },
};

export function validateDraft(value, project) {
  const text = item => typeof item === 'string' && item.trim().length > 0;
  if (!value || typeof value !== 'object' || Object.keys(value).length !== Object.keys(fields).length ||
      !Object.entries(fields).every(([key, field]) => field.type === 'string'
        ? typeof value[key] === 'string'
        : Array.isArray(value[key]) && value[key].every(text))) {
    throw new Error('模型返回的草稿格式无效');
  }
  const { questions, ...draft } = value;
  if (questions.length) return { questions };
  if (!text(draft.goal) || !text(draft.approach) || !draft.acceptance_criteria.length || !draft.suggested_paths.length) {
    throw new Error('草稿需要目标、方案、至少一项验收条件和一个建议路径');
  }
  const suggestedPaths = [...new Set(draft.suggested_paths.map(path => relativePath(path.trim())))];
  if (!suggestedPaths.every(path => project.allowedPaths.some(root => pathWithin(path, root)))) {
    throw new Error('模型建议的路径超出项目配置。请澄清修改范围后再生成草稿');
  }
  return { draft: { ...draft, suggested_paths: suggestedPaths } };
}

export function createDiscussionProvider({ provider, model, apiKey, fetchImpl = fetch }) {
  const { name, endpoint, options } = discussionBackend(provider);
  return async ({ project, messages, draft = false, previousDraft, signal }) => {
    const { description, allowedPaths, verificationCommands, forbiddenOperations } = project;
    const instructions = [
      '你是 CCCP 的需求讨论助手。用用户的语言澄清软件需求，区分目标、实现建议和可验证的预期结果。',
      '你看不到仓库文件，也没有工具和审批权限。请根据用户提供的信息和项目配置给建议，避免声称已读取或已修改仓库。',
      '必要时追问，不要编造用户同意的条件或批准。建议的路径必须在配置范围内。验证命令以配置为准。',
      draft
        ? '整理最新讨论为草稿。已有信息足够时将 questions 留空。若目标、验收或范围仍有歧义，用 questions 追问，尚未确定的字段可填空。'
        : '这是一轮普通对话。优先回答用户，再提出必要的澄清问题。',
      `项目参考数据 ${JSON.stringify({ description, allowedPaths, verificationCommands, forbiddenOperations })}`,
      ...(previousDraft ? [`上一版候选草稿，仅供讨论参考 ${JSON.stringify(previousDraft)}`] : []),
    ].join('\n');
    const input = messages.map(({ role, content }) => ({ role, content }));
    if (draft) input.push({
      role: 'user',
      content: '请将截至当前的需求整理成任务草稿。只返回一个 JSON 对象，不要 Markdown、代码围栏或额外说明。'
        + `字段及类型如下：${JSON.stringify(fields)}。所有字段都要出现。`,
    });

    let response;
    try {
      const timeout = AbortSignal.timeout(90000);
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        body: JSON.stringify({ model, ...options, instructions, input, ...(draft ? { text: { format } } : {}) }),
      });
    } catch (error) {
      if (signal?.aborted) throw new Error('已取消模型请求');
      throw new Error(error.name === 'TimeoutError' ? '讨论模型请求超时，请重试' : `无法连接 ${name} Responses API，请检查网络后重试`);
    }
    if (!response.ok) {
      const hints = {
        401: '请检查 API 凭据',
        402: '请检查 API 账户余额',
        403: '请检查 API 项目权限',
        404: '请检查所选模型是否对当前 API 项目可用',
        429: '请检查额度或限流后重试',
      };
      throw new Error(`${name} 请求失败（HTTP ${response.status}）。${hints[response.status] ?? '请检查模型和请求配置，或稍后重试'}`);
    }
    let result;
    try { result = await response.json(); }
    catch { throw new Error('讨论服务的响应无法读取，请重试'); }
    if (result?.status !== 'completed' || !Array.isArray(result.output)) throw new Error('讨论模型没有返回完整结果');
    const content = result.output.filter(item => item?.type === 'message' && item.role === 'assistant' && Array.isArray(item.content))
      .flatMap(item => item.content);
    if (content.some(item => item.type === 'refusal')) throw new Error('讨论模型拒绝了这次请求，请调整输入');
    const text = content.filter(item => item?.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('').trim();
    if (!text) throw new Error('讨论模型没有返回文字');
    if (!draft) return { text, model: result.model ?? model };
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('模型返回的草稿不是有效 JSON'); }
    return { ...validateDraft(parsed, project), model: result.model ?? model };
  };
}
