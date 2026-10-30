import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "dsh-git-view";
export declare const inject: string[];
/**
 * The Git panel's settings, as dsh-git-panel offers them on the plugin's detail page: volatile fields apply at once; the
 * limits stay in the profile.
 */
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    showInputPill: Schema<boolean, boolean, "volatile-defined">;
    placement: Schema<"all" | "tab" | "sidebar", "all" | "tab" | "sidebar", "volatile-defined">;
    defaultDiffView: Schema<"split" | "unified", "split" | "unified", "volatile-defined">;
    graphStyle: Schema<"compact" | "parallel", "compact" | "parallel", "volatile-defined">;
    fontDelta: Schema<0 | 1 | -1, 0 | 1 | -1, "volatile-defined">;
    detectCheckouts: Schema<boolean, boolean, "volatile-defined">;
    filesFollowRepo: Schema<boolean, boolean, "volatile-defined">;
    suggestEnabled: Schema<boolean, boolean, "volatile-defined">;
    suggestLanguage: Schema<"auto" | "zh" | "en", "auto" | "zh" | "en", "volatile-defined">;
    suggestMaxBytes: Schema<number, number, "volatile-defined">;
    suggestMaxOutputTokens: Schema<number, number, "volatile-defined">;
    suggestTimeoutMs: Schema<number, number, "volatile-defined">;
    suggestProvider: Schema<string, string, "volatile">;
    suggestModel: Schema<string, string, "volatile">;
    suggestReasoningEffort: Schema<string, string, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    showInputPill: Schema<boolean, boolean, "volatile-defined">;
    placement: Schema<"all" | "tab" | "sidebar", "all" | "tab" | "sidebar", "volatile-defined">;
    defaultDiffView: Schema<"split" | "unified", "split" | "unified", "volatile-defined">;
    graphStyle: Schema<"compact" | "parallel", "compact" | "parallel", "volatile-defined">;
    fontDelta: Schema<0 | 1 | -1, 0 | 1 | -1, "volatile-defined">;
    detectCheckouts: Schema<boolean, boolean, "volatile-defined">;
    filesFollowRepo: Schema<boolean, boolean, "volatile-defined">;
    suggestEnabled: Schema<boolean, boolean, "volatile-defined">;
    suggestLanguage: Schema<"auto" | "zh" | "en", "auto" | "zh" | "en", "volatile-defined">;
    suggestMaxBytes: Schema<number, number, "volatile-defined">;
    suggestMaxOutputTokens: Schema<number, number, "volatile-defined">;
    suggestTimeoutMs: Schema<number, number, "volatile-defined">;
    suggestProvider: Schema<string, string, "volatile">;
    suggestModel: Schema<string, string, "volatile">;
    suggestReasoningEffort: Schema<string, string, "volatile">;
}>>, "plain">;
export declare function apply(ctx: Context, config?: unknown): void;
