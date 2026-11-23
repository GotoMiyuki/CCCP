import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relativePath } from '../authority.mjs';
import { check, defaultProfile } from '../contracts.mjs';
import { record, nonempty } from '../runtime/contracts.mjs';
import { safeGit } from '../safe-git.mjs';
import { discussionBackend } from './responses.mjs';

const defaultConfig = fileURLToPath(new URL('../../examples/chat-config.json', import.meta.url));

export async function loadChatConfig(path = defaultConfig, env = process.env) {
  const config = record(JSON.parse(await readFile(path, 'utf8')), '聊天配置', ['project', 'chatting_agent']);
  const project = record(config.project, '项目配置', ['repository', 'description', 'allowed_paths', 'verification_commands']);
  nonempty(project.repository, 'project.repository');
  nonempty(project.description, 'project.description');
  if (!Array.isArray(project.allowed_paths) || project.allowed_paths.length === 0) {
    throw new Error('project.allowed_paths 至少需要一个仓库内路径');
  }

  const agent = record(config.chatting_agent, '讨论模型配置', ['provider', 'model', 'model_env', 'api_key_env']);
  discussionBackend(agent.provider);
  for (const name of ['model_env', 'api_key_env']) {
    if (typeof agent[name] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(agent[name])) {
      throw new Error(`chatting_agent.${name} 应为环境变量名`);
    }
  }
  if (agent.model !== undefined) nonempty(agent.model, 'chatting_agent.model');
  const repository = resolve(dirname(path), project.repository);
  const profile = { ...defaultProfile(repository), verification_commands: project.verification_commands };
  check('Profile', profile);
  return {
    project: {
      repository,
      description: project.description,
      allowedPaths: [...new Set(project.allowed_paths.map(relativePath))],
      verificationCommands: profile.verification_commands,
      forbiddenOperations: profile.delegation.forbidden,
    },
    chat: {
      provider: agent.provider,
      model: env[agent.model_env]?.trim() || agent.model?.trim(),
      apiKey: env[agent.api_key_env]?.trim(),
      modelEnv: agent.model_env,
      apiKeyEnv: agent.api_key_env,
    },
  };
}

export async function snapshotProject(project) {
  const repository = await realpath(project.repository);
  const { stdout } = await safeGit(repository, ['rev-parse', '--show-toplevel', 'HEAD']);
  const [root, commit] = stdout.trimEnd().split(/\r?\n/);
  if (await realpath(root) !== repository || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit ?? '')) {
    throw new Error('请将 project.repository 指向含有提交的 Git 仓库根目录');
  }
  return { ...project, repository, commit };
}
