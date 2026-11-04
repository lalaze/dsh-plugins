/**
 * Team presets for the `/team` command: a roster and a task template that start an AgentTeams team
 * (`@nanmicoder/dsh-agent-teams`) in one line, with remote CLIs as the members' models.
 */
/** A preset member. Without a CLI the member keeps the captain's DSH model. */
export interface PresetMember {
    name: string;
    role?: string;
    cli?: string;
    model?: string;
    effort?: string;
}
/** A task template; `{goal}` in the subject or description is replaced by the goal the user typed. */
export interface PresetTask {
    id: string;
    subject: string;
    description?: string;
    assignee?: string;
    dependencies?: string[];
}
export interface TeamPreset {
    id: string;
    label?: string;
    members: PresetMember[];
    tasks: PresetTask[];
}
/** What `name=cli/model@effort` or `name=captain` asks for one member. */
export interface MemberSpec {
    cli?: string;
    model?: string;
    effort?: string;
    captain?: boolean;
}
export interface TeamInvocation {
    preset?: string;
    members: Map<string, MemberSpec>;
    goal: string;
    review: boolean;
    name?: string;
}
export declare const PRESET_ID: RegExp;
export declare const MEMBER_NAME: RegExp;
export declare const MAX_PRESETS = 32, MAX_MEMBERS = 8, MAX_TASKS = 32;
export declare const CAPTAIN_SPEC = "captain";
/** Presets every installation has; a saved preset with the same id replaces it. */
export declare const BUILTIN_PRESETS: readonly TeamPreset[];
/** Saved presets first, then the built-ins they do not replace. */
export declare function allPresets(saved: readonly TeamPreset[]): TeamPreset[];
/** The CLI id for a user-typed name: `Codex`, `codex` and `claude` all resolve. */
export declare function cliOf(value: string): string | undefined;
/** Validate one preset as saved or sent by the settings page. */
export declare function teamPresetInput(raw: unknown): TeamPreset;
/** `codex`, `codex/gpt-5`, `claude/opus@high` or `captain`. */
export declare function parseMemberSpec(spec: string): MemberSpec;
/**
 * `/team [preset] [member=cli[/model][@effort] …] [--plan] [--name <team>] <goal>`. Options and member
 * assignments lead; the goal is the rest of the line as typed. A leading word that names a preset selects it.
 */
export declare function parseTeamCommand(rawInput: string, presetIds: readonly string[]): TeamInvocation;
/** The preset a line selects: the named one, else the first whose members cover every assignment. */
export declare function choosePreset(invocation: TeamInvocation, presets: readonly TeamPreset[]): TeamPreset;
