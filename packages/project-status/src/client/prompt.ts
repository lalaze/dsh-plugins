/**
 * The two texts that tell an agent about the status file. The file is outside the repository, so an agent only knows of
 * it when told: once, by the request the view puts into the conversation, or always, by a rule in the project's own
 * instructions. Agents write the headings they are shown, so the texts name them in the page's language.
 */
const SECTIONS = {
  zh: ['## 目标 —— 当前里程碑要交付什么', '## 进度 —— 已完成什么、正在做什么（写上分支名）', '## 卡点 —— 卡在哪，在等谁：我、agent 还是外部；没有就留空', '## 下一步 —— 一条可以直接交给 agent 执行的指令'],
  en: ['## Goal: what this milestone has to deliver', '## Progress: what is done and what is under way (name the branch)', '## Blockers: what it is stuck on and who it waits for (me, an agent, someone outside); leave it empty when there is none',
    '## Next: one instruction an agent could carry out as it stands'],
};

/** Asks the agent of a conversation to bring the file up to date from what the conversation did. */
export const updateRequest = (file: string, language: 'zh' | 'en'): string => language === 'zh'
  ? [`请更新这个项目的状态文件：${file}`, '先读它现有的内容（没有就新建），再根据这次对话的进展改写下面四个二级小节。小节标题只写破折号前的部分，其他小节不要动：',
    ...SECTIONS.zh, '每个小节不超过 5 行。只改这一个文件。'].join('\n')
  : [`Update this project's status file: ${file}`, 'Read what it says first (create it if it is missing), then rewrite these four second-level sections from what this conversation did. A heading is the part before the colon; leave other sections alone:',
    ...SECTIONS.en, 'At most 5 lines a section. Change only this file.'].join('\n');

/** A rule for the project's AGENTS.md or CLAUDE.md, so that agents keep the file current without being asked. */
export const standingRule = (file: string, language: 'zh' | 'en'): string => language === 'zh'
  ? ['## 项目状态', '', `本项目的状态记录在 \`${file}\`，所有 worktree 和分支共用一份，不在仓库里。`, '',
    '- 开始工作前先读它。', '- 完成一段工作或停下来等人时，更新其中的「目标」「进度」「卡点」「下一步」四个二级小节，每节不超过 5 行，其他小节不要动。',
    '- 「卡点」写明在等谁：我、agent 还是外部；「下一步」写成一条可以直接执行的指令。'].join('\n')
  : ['## Project status', '', `This project's status is kept in \`${file}\`, one file for every worktree and branch, outside the repository.`, '',
    '- Read it before starting work.', '- When a piece of work is done, or you stop to wait for someone, update its four second-level sections, Goal, Progress, Blockers and Next, at most 5 lines each, and leave other sections alone.',
    '- Blockers says who it waits for: me, an agent or someone outside. Next is one instruction that can be carried out as it stands.'].join('\n');
