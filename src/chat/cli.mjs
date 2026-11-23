import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { loadChatConfig, snapshotProject } from './config.mjs';
import { createDiscussionProvider } from './responses.mjs';
import { openSessionStore } from './session-store.mjs';
import { createTaskHandoff, draftProfile } from './task-handoff.mjs';
import { prepareDateDemo } from './date-demo.mjs';
import { fileURLToPath } from 'node:url';

const demoConfig = fileURLToPath(new URL('../../examples/chat-deepseek-config.json', import.meta.url));

const help = [
  '直接输入需求或补充条件，与 chatting_agent 讨论。',
  '/draft  生成下一版草稿',
  '/show [版本号]  查看指定版本，省略版本号时查看最新版',
  '/approve <版本号>  批准当前草稿并创建任务',
  '/task  查看任务状态与工作区',
  '/run  实施已批准的日期示例任务并运行审查',
  '/defer [理由]  暂缓验收并保留当前结果',
  '/accept <理由>  记录人工验收',
  '/history  查看已保存的对话',
  '/help  显示命令',
  '/exit  退出',
].join('\n');

// Keep model text and config data from becoming terminal control sequences.
const printable = text => String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

function showDraft(print, project, entry, messageCount) {
  if (!entry) { print('暂无草稿。讨论后使用 /draft 生成。'); return; }
  const list = items => items.map(item => `  - ${item}`).join('\n') || '  （无）';
  const draft = entry.content;
  print(`草稿 v${entry.version} · ${entry.model}${entry.messageCount < messageCount ? ' · 还有后续讨论，可用 /draft 更新' : ''}`);
  print(`草稿基线：${entry.baseCommit ?? project.commit}`);
  print(`目标：${draft.goal}\n方案：${draft.approach}`);
  print(`约束\n${list(draft.constraints)}\n非目标\n${list(draft.non_goals)}`);
  print(`验收条件\n${list(draft.acceptance_criteria)}\n建议修改路径\n${list(draft.suggested_paths)}`);
  const profile = draftProfile(project, project.repository);
  print(`拟授权的操作类别\n${list(profile.delegation.allowed)}\n项目禁止的操作类别\n${list(profile.delegation.forbidden)}`);
  print(`项目配置中的验证命令\n${list(profile.verification_commands.map(command => JSON.stringify(command)))}`);
  print('批准后会按以上范围创建独立工作区，任务要求独立 R3 审查和人工验收。');
}

function showTask(print, approval, task, details = true) {
  print(`任务 ID：${approval.request.context.task_id}\n批准版本：v${approval.draftVersion} · ${approval.approvedAt}\n获批基线：${approval.baseCommit}`);
  if (task) {
    print(`任务状态：${task.state}\n工作区：${task.workspace}\nAgent 运行次数：${task.modelRuns} · 工具操作次数：${task.operations}`);
    if (task.blocked) print(`阻塞原因：${task.blocked.reason}`);
    if (task.changeProposal) print(`变更提议：${task.changeProposal.problem}`);
    if (task.unsettled?.length) print(`尚未确认结束的操作（RECONCILIATION_REQUIRED）：${task.unsettled.join('、')}`);
    if (task.lastDeferral) {
      print(`最近暂缓验收：${task.lastDeferral.timestamp}${task.lastDeferral.data.reason ? ` · ${task.lastDeferral.data.reason}` : ''}`);
    }
    if (task.acceptance) {
      const { actor, data, timestamp } = task.acceptance;
      print(`人工验收：${actor.id} · ${timestamp}\n验收理由：${data.acceptance}`);
      if (data.review_id) print(`验收依据：R3 ${data.review_id} · ${data.evidence.length} 项证据`);
    }
    if (task.state === 'HUMAN_ACCEPTANCE') print('已到达待人工验收。用 /task 核对证据，可先在工作区试跑，再用 /accept <理由> 或 /defer。');
    if (!details) return;
    for (const file of task.diff ?? []) {
      print(`改动文件：${file.path}\n改动前\n${(file.before ?? '（不存在）').slice(0, 4000)}\n改动后\n${(file.after ?? '（不存在）').slice(0, 4000)}`);
    }
    if (task.test) print(`测试结果：${task.test.outcome}\n${(task.test.result?.stdout ?? '').slice(0, 4000)}${(task.test.result?.stderr ?? '').slice(0, 2000)}`);
    for (const review of task.reviews ?? []) {
      print(`${review.review_level}：${review.decision} · ${review.reason}`);
      if (review.review_level === 'R2') {
        const assessed = new Map(review.requirements.map(item => [item.requirement_id, item]));
        for (const clause of task.clauses) {
          const item = assessed.get(clause.id);
          const sources = item?.evidence.map(ref => task.evidenceTypes[ref] ?? ref).join(', ');
          print(`  ${clause.id} ${item?.status ?? 'unknown'}${sources ? ` [${sources}]` : ''} · ${clause.text}`);
        }
      }
    }
  } else {
    print('批准已保存。Runtime 当前没有已提交的任务记录。');
  }
}

export async function runChat({
  args = process.argv.slice(2), env = process.env, input = process.stdin, output = process.stdout,
  databasePath = resolve('.cccp', 'chat.sqlite'), fetchImpl = fetch,
} = {}) {
  const { values } = parseArgs({ args, options: {
    config: { type: 'string' }, resume: { type: 'string' }, demo: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const print = text => output.write(`${printable(text)}\n`);
  if (values.help) {
    print(`npm run chat -- [--demo] [--config <配置.json>] [--resume <会话ID>]\n${help}`);
    return;
  }

  const config = await loadChatConfig(values.config ?? (values.demo ? demoConfig : undefined), env);
  const { chat } = config;
  const missing = [!chat.model && chat.modelEnv, !chat.apiKey && chat.apiKeyEnv].filter(Boolean);
  const discuss = missing.length ? null : createDiscussionProvider({ ...chat, fetchImpl });
  const database = await openSessionStore(databasePath);
  const handoff = createTaskHandoff(databasePath);
  const controller = new AbortController();
  let reader;
  try {
    let session = values.resume ? database.load(values.resume) : database.create(await snapshotProject(
      values.demo ? await prepareDateDemo(handoff.demoRepository) : config.project,
    ));
    let viewedVersion;
    const present = entry => {
      showDraft(print, session.project, entry, session.messages.length);
      viewedVersion = entry?.version;
    };
    print(`CCCP 需求讨论 · 会话 ${session.id}`);
    print(`项目：${session.project.repository}\n会话起始提交：${session.project.commit}`);
    print(`chatting_agent：${chat.provider} / ${chat.model ?? '待配置'}`);
    if (!discuss) print(`启用模型对话需要设置：${missing.join(', ')}。仍可查看已保存的记录。`);
    print(session.project.demo ? '批准日期示例草稿后，输入 /run 开始实施和审查。' : '可讨论需求、生成草稿并批准创建任务。');
    print(help);
    if (values.resume && session.approval) {
      try { showTask(print, session.approval, await handoff.inspect(session.approval), false); }
      catch (error) { print(`任务状态读取失败：${error.message}`); }
    } else if (values.resume && session.drafts.length) present(session.drafts.at(-1));

    reader = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY), prompt: '你 > ', crlfDelay: Infinity });
    const stop = () => { controller.abort(); reader.close(); };
    reader.on('SIGINT', stop);
    // Attach the iterator before prompting so redirected or rapidly pasted lines are queued.
    const lines = reader[Symbol.asyncIterator]();
    if (reader.terminal) reader.prompt();
    for await (const raw of lines) {
      if (controller.signal.aborted) break;
      const line = raw.trim();
      if (line === '/exit') break;
      try {
        if (line === '/help') {
          print(help);
        } else if (/^\/(accept|defer)(\s|$)/.test(line)) {
          session = database.load(session.id);
          if (!session.approval) throw new Error('请先批准草稿并创建任务');
          const accept = line.startsWith('/accept');
          const reason = line.slice(accept ? '/accept'.length : '/defer'.length).trim();
          if (accept && !reason) throw new Error('请输入 /accept <验收理由>');
          const task = accept
            ? await handoff.accept(session.approval, reason)
            : await handoff.defer(session.approval, reason || null);
          showTask(print, session.approval, task, false);
        } else if (line === '/run') {
          session = database.load(session.id);
          if (!session.approval) throw new Error('请先批准草稿并创建任务');
          try {
            const task = await handoff.run(session.approval, { env, fetchImpl, signal: controller.signal, progress: print });
            showTask(print, session.approval, task);
          } catch (error) {
            print(`执行中止：${error.message}`);
            showTask(print, session.approval, await handoff.inspect(session.approval));
          }
        } else if (line === '/task' || /^\/approve [1-9]\d*$/.test(line)) {
          session = database.load(session.id);
          const approve = line !== '/task';
          if (approve) {
            const version = Number(line.slice('/approve '.length));
            if (session.approval && session.approval.draftVersion !== version) {
              throw new Error('这个会话已有批准记录。请用 /task 查看，或开启新会话提出另一项任务');
            }
            if (!session.approval) {
              if (viewedVersion !== version) throw new Error('请先用 /show 查看要批准的最新草稿');
              const approval = await handoff.prepare(session, version);
              session = database.save(session, { approval });
            }
          }
          if (!session.approval) {
            print('暂无已批准任务。');
          } else {
            const approval = session.approval;
            const task = approve ? await handoff.submit(approval) : await handoff.inspect(approval);
            if (task && !approval.receipt) {
              session = database.save(session, { approval: { ...approval, receipt: { taskId: task.id, receivedAt: new Date().toISOString() } } });
            }
            showTask(print, approval, task);
          }
        } else if (line === '/history') {
          if (!session.messages.length) print('暂无已保存的对话。');
          for (const message of session.messages) print(`${message.role === 'user' ? '你' : '讨论助手'}：${message.content}`);
        } else if (line === '/show' || /^\/show [1-9]\d*$/.test(line)) {
          const entry = line === '/show' ? session.drafts.at(-1) : session.drafts.find(item => item.version === Number(line.slice(6)));
          if (line !== '/show' && !entry) print('找不到该版本的草稿。');
          else present(entry);
        } else if (line.startsWith('/') && line !== '/draft') {
          print('未知命令。用 /help 查看当前可用命令。');
        } else if (line) {
          if (session.approval) throw new Error('这个会话的授权已冻结。请用 /task 查询，或开启新会话继续讨论');
          if (!discuss) throw new Error(`请先设置 ${missing.join(', ')}，再用当前会话 ID 继续`);
          const draft = line === '/draft';
          if (draft && !session.messages.length) throw new Error('先输入你的需求，再使用 /draft');
          const baseCommit = draft ? (await snapshotProject(session.project)).commit : null;
          print(draft ? '正在整理草稿…' : '正在等待讨论助手…');
          const messages = draft ? session.messages : [...session.messages, { role: 'user', content: line }];
          const answer = await discuss({
            project: session.project, messages, draft, previousDraft: session.drafts.at(-1)?.content, signal: controller.signal,
          });
          if (controller.signal.aborted) break;
          if (answer.draft) {
            const entry = {
              version: session.drafts.length + 1, messageCount: messages.length, baseCommit,
              createdAt: new Date().toISOString(), model: answer.model, content: answer.draft,
            };
            session = database.save(session, { drafts: [...session.drafts, entry] });
            present(entry);
          } else {
            const text = answer.text ?? answer.questions.map(question => `- ${question}`).join('\n');
            const turns = draft ? [...messages, { role: 'user', content: '请整理成任务草稿。' }] : messages;
            session = database.save(session, { messages: [...turns, { role: 'assistant', content: text, model: answer.model }] });
            print(`讨论助手：${text}`);
          }
        }
      } catch (error) {
        print(`操作未完成：${error.message}`);
      }
      if (reader.terminal && !controller.signal.aborted) reader.prompt();
    }
    print(`继续此会话：npm run chat -- ${values.demo ? '--demo ' : ''}--resume ${session.id}${values.config ? '（请附上同一个 --config 参数）' : ''}`);
  } finally {
    reader?.close();
    database.close();
  }
}

if (import.meta.main) {
  runChat().catch(error => {
    process.stderr.write(`无法启动交互宿主：${printable(error.message)}\n`);
    process.exitCode = 1;
  });
}
