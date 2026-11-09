/** Audited public 0.2.2-rc.1 compose/prompt seams, loaded from the HOST's
 * runtime rather than the plugin's older optional SDK facade. */
export function nativeHostAdapter(ctx: any) {
  let hostScope: any;
  const injected = ctx.inject(['loader'], (scope: any) => { hostScope = scope; });
  const load = async (name: string): Promise<any> => {
    await injected.await();
    const loader = hostScope.loader;
    return hostScope.extend({ baseUrl: loader.config.baseUrl ?? hostScope.baseUrl }).loader.import(name);
  };
  let modules: Promise<any[]> | undefined;
  const api = () => modules ??= Promise.all(['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-llm'].map(load));
  const presentation = async (agent: any, signal?: AbortSignal) => {
    signal ??= new AbortController().signal;
    const [agents, prompts, llm] = await api();
    const selection = agent.model.current();
    if (!selection) throw new Error('Select an ordinary model before composing a shared continuation');
    const toolSet = await agent.ctx.get('tools').resolve({ agent, modelSelection: selection, signal });
    try {
      const assembly = await agent.ctx.get('systemPrompt').assemble({ ...agents.assembleContextFor(agent, signal), modelSelection: selection, toolSet });
      const sections = prompts.renderContextSections(assembly);
      return { llm, system: prompts.renderPrompt(assembly), tools: assembly.tools, sections,
        runtime: prompts.joinContextSections(sections) || 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.' };
    } finally { toolSet.dispose(); }
  };
  return {
    load,
    /** Source-audited 0.2.2-rc.1 title boundary, including preparation and the
     * post-stream title append. runProvider is a host implementation seam,
     * NOT an optional SDK hook; incompatible hosts must fail closed. */
    fenceLifecycle(hooks: { enter(id: string): void; leave(id: string): void; admit(id: string): Promise<void>; rejected(id: string, line: string, attachments: unknown[]): void }) {
      ctx.inject(['sessionTitle'], (scope: any) => {
        const title = scope.sessionTitle;
        if (typeof title.runProvider !== 'function') return; // Native capability check keeps this incompatible host disabled.
        const original = title.runProvider;
        const run = async function(this: any, session: any, work: any, route: any) {
          hooks.enter(session.id);
          try {
            try { await hooks.admit(session.id); }
            catch (error) {
              // Native finally owns clearing its active revision. Aborting
              // before calling it prevents even its fallback/title-request log.
              work.controller.abort(error);
              return await original.call(this, session, work, route);
            }
            return await original.call(this, session, work, route);
          } finally { hooks.leave(session.id); }
        };
        title.runProvider = run;
        scope.effect(() => () => { if (title.runProvider === run) title.runProvider = original; });
      });
      ctx.inject(['commands'], (scope: any) => {
      const commands = scope.commands;
      const original = commands.execute;
      const execute = async function(this: any, agent: any, line: string, attachments: unknown[], signal: AbortSignal) {
        hooks.enter(agent.id);
        try {
          try { await hooks.admit(agent.id); }
          catch (error) { hooks.rejected(agent.id, line, attachments); throw error; }
          return await original.call(this, agent, line, attachments, signal);
        } finally { hooks.leave(agent.id); }
      };
      commands.execute = execute;
      scope.effect(() => () => { if (commands.execute === execute) commands.execute = original; });
      });
    },
    async setup(agentCtx: any) {
      const [agents] = await api();
      // Same setup order as ApiSessionAgentController.composeAgent(). The local
      // deployment chooses the preset; the source's preset is never mounted.
      agents.installModelSelection(agentCtx);
      const presets = ctx.get('agentPresets');
      if (presets) await presets.mount(agentCtx, (await presets.resolve(undefined)).id);
    },
    /** Native compaction selects its span BEFORE streaming. Rebuild only its
     * public summarizer input, without changing that span during the call. The
     * native summarizer logs the resulting exact request in compaction/summary. */
    async compactionInput(input: any, agent: any, signal?: AbortSignal) {
      const p = await presentation(agent, signal);
      return { ...input, tools: p.tools, messages: [p.llm.createSystemMessage(p.system),
        ...input.messages.filter((m: any) => m.role !== 'system').map((m: any) => m.source?.kind === 'runtime-context'
          ? { ...m, content: [{ type: 'text', text: p.runtime }], source: {kind: 'runtime-context', form: 'snapshot', sections: p.sections} } : m)] };
    },
  };
}
