import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_RESTRICTED } from '../contracts.mjs';
import { safeGit } from '../safe-git.mjs';

export const demoFiles = Object.freeze(['src/date.mjs', 'tests/checks.mjs']);
export const demoCommand = Object.freeze(['node', '--test', 'tests/checks.mjs']);
export const demoId = 'date-validation';

export async function prepareDateDemo(repository) {
  let created = false;
  try { await mkdir(repository); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (created) {
    await mkdir(join(repository, 'src'));
    await mkdir(join(repository, 'tests'));
    for (const file of demoFiles) {
      await copyFile(new URL(`../../examples/date-demo/${file}`, import.meta.url), join(repository, file));
    }
    await safeGit(repository, ['init']);
    await safeGit(repository, ['add', '--', ...demoFiles]);
    await safeGit(repository, ['-c', 'user.name=CCCP Demo', '-c', 'user.email=demo@example.invalid',
      'commit', '-m', 'Initialize date validation demo']);
  }
  return {
    demo: demoId, repository, allowedPaths: [...demoFiles], verificationCommands: [[...demoCommand]],
    forbiddenOperations: [...DEFAULT_RESTRICTED],
    description: '日期校验示例。src/date.mjs 导出 isValidDate(year, month, day)，命令行输出 valid 或 invalid date。'
      + '当前只检查月份 1–12、日 1–31。请将任务限定为用户指定的日期规则。'
      + '草稿只保留用户提出的行为、约束和回归要求。用户只指定函数时，将验收样例写成函数调用。'
      + '建议修改路径要包含 src/date.mjs 和 tests/checks.mjs。后者用于补充这项需求的回归测试。',
  };
}
