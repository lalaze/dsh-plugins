/**
 * The two texts that tell an agent about the status file. The file is outside the repository, so an agent only knows of
 * it when told: once, by the request the view puts into the conversation, or always, by a rule in the project's own
 * instructions. Agents write the headings they are shown, so the texts name them in the page's language. A project has
 * several goals under way, each in conversations of its own, so an agent is told to write only the one it worked on.
 */
const SHAPE = {
  zh: ['## 大目标 —— 整个项目要达成什么，一两句话', '## 小目标 —— 下面每个三级标题是一个小目标，各有自己的状态：', '### [ ] 小目标的名字（达成后改成 [x]）', '- [ ] 这个小目标的待办，一行一条；做完的改成 [x]，不要删掉',
    '#### 进度 —— 已完成什么、正在做什么（写上分支名）', '#### 卡点 —— 卡在哪，在等谁：我、agent 还是外部；没有就不写这一节', '#### 下一步 —— 一条可以直接交给 agent 执行的指令'],
  en: ['## Goal: what the project as a whole is for, in a sentence or two', '## Sub-goals: each third-level heading under it is one goal with a status of its own:', '### [ ] The goal\'s name (make it [x] once it is reached)',
    '- [ ] what this goal still takes, one line each; tick what is done as [x] and leave it in', '#### Progress: what is done and what is under way (name the branch)',
    '#### Blockers: what it is stuck on and who it waits for (me, an agent, someone outside); leave the section out when there is none', '#### Next: one instruction an agent could carry out as it stands'],
};

/** Asks the agent of a conversation to bring the file up to date from what the conversation did. */
export const updateRequest = (file: string, language: 'zh' | 'en'): string => language === 'zh'
  ? [`请更新这个项目的状态文件：${file}`, '先读它现有的内容（没有就新建）。文件的结构如下，标题只写破折号前的部分：', ...SHAPE.zh,
    '只更新这次对话在做的那个小目标（文件里还没有就新增一个），其他小目标和其他小节不要动。进度、卡点、下一步每节不超过 5 行。只改这一个文件。'].join('\n')
  : [`Update this project's status file: ${file}`, 'Read what it says first (create it if it is missing). It is laid out like this; a heading is the part before the colon:', ...SHAPE.en,
    'Update only the goal this conversation worked on (add it when the file does not have it yet), and leave the other goals and other sections alone. At most 5 lines each for Progress, Blockers and Next. Change only this file.'].join('\n');

/** A rule for the project's AGENTS.md or CLAUDE.md, so that agents keep the file current without being asked. */
export const standingRule = (file: string, language: 'zh' | 'en'): string => language === 'zh'
  ? ['## 项目状态', '', `本项目的状态记录在 \`${file}\`，所有 worktree 和分支共用一份，不在仓库里。`, '',
    '- 开始工作前先读它，找到你这次要做的小目标。', '- 完成一段工作或停下来等人时，只更新你在做的那个小目标（没有就新增一个），其他小目标和其他小节不要动。',
    '- 小目标是「小目标」小节下的一个三级标题 `### [ ] 名字`（达成后改成 `[x]`），下面是它的待办 `- [ ]`，以及四级标题「进度」「卡点」「下一步」，每节不超过 5 行。',
    '- 「卡点」写明在等谁：我、agent 还是外部，没有就不写这一节；「下一步」写成一条可以直接执行的指令。'].join('\n')
  : ['## Project status', '', `This project's status is kept in \`${file}\`, one file for every worktree and branch, outside the repository.`, '',
    '- Read it before starting work, and find the goal you are about to work on.', '- When a piece of work is done, or you stop to wait for someone, update only the goal you worked on (add it when it is missing), and leave the other goals and other sections alone.',
    '- A goal is a third-level heading `### [ ] name` under the Sub-goals section (`[x]` once it is reached), followed by its to-dos as `- [ ]` and the fourth-level headings Progress, Blockers and Next, at most 5 lines each.',
    '- Blockers says who it waits for: me, an agent or someone outside; leave the section out when there is none. Next is one instruction that can be carried out as it stands.'].join('\n');
