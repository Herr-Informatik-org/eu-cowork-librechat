import type { GenericTool } from '@librechat/agents';
import type { AppConfig } from '@librechat/data-schemas';
import { NEXT_STEPS_INSTRUCTIONS, isNextStepsEnabled } from './followup';
import { PLAN_INSTRUCTIONS, createPlanTool, isPlanEnabled } from './plan';
import { isSafeWorkEnabled } from './safeWork';

export const WORK_GUIDANCE = `Arbeite lange Chats kundenweise ab. Lade zuerst den passenden Skill und seine benötigten aktuellen Regeln. Brain ergänzt nur konkret fehlende Informationen und ersetzt weder Skills noch aktuelle Nutzerfreigaben oder frische Geschäftsdaten. Lade unveränderte Modellkataloge und Skill-Referenzen nicht unnötig erneut.
Bei grossen Abfragen: gezielte Felder und kleine, vollständig abgearbeitete Seiten verwenden. Eine Antwort mit reference/nextOffset ist noch nicht vollständig gelesen. Rufe arbeitsdaten_lesen abschnittsweise bis fullyRead=true auf, soweit der Auftrag eine vollständige Detailprüfung verlangt. upstreamIncomplete=true verlangt eine kleinere neue Originalabfrage; behaupte bis dahin keine Vollständigkeit.
Halte je Kunde mit arbeitsstand_sichern einen kompakten Arbeitsstand, offene IDs, bestätigte Korrekturen und Quellenverweise fest. Nach dem Abschluss nenne alle geänderten records mit model und id und alle verwendeten paginierten references. Erst erfolgreiche Einzel-Rücklesekontrollen erlauben completed. Einzelprüfung bleibt Pflicht. Bewahre Freigaben anhand der Originalnachrichten und genauen Zielwerte; eine Zusammenfassung ist keine Freigabe. Bei Bezug auf frühere Kunden gezielt die Originalquellen nachladen.
Eine update_record-Antwort mit verified=true enthält bereits die verpflichtende frische Einzelprüfung und Rücklesekontrolle aller geänderten Felder. Wiederhole denselben Schreibaufruf nicht. Bei unklarem Ergebnis keine neue Änderung beginnen; Zustand abgleichen und ausdrücklich pausieren. Plane ohne neue Modellentscheidung zwischen unnötig wiederholten Einzelabfragen. Werkzeugausfälle, Kostenpausen und fehlende Quellenteile sind offene Arbeit, kein erfolgreicher Abschluss.`;

const NON_WORK_TOOLS = new Set(['ask_user_question']);

interface GuidedAgent {
  tools?: unknown[];
  toolDefinitions?: Array<{ name: string }>;
}

export interface ChatGuidance {
  /** Static system text appended after the agent's own instructions. */
  instructions: string;
  /** In-graph host tools to bind (the plan tool). */
  tools: GenericTool[];
}

const NONE: ChatGuidance = { instructions: '', tools: [] };

/** An agent works in several steps only when it can call at least one real tool. */
function hasWorkTools(agent: GuidedAgent): boolean {
  const named = (name: unknown): boolean => typeof name === 'string' && !NON_WORK_TOOLS.has(name);
  return (
    (agent.toolDefinitions?.some((def) => named(def.name)) ?? false) ||
    (agent.tools?.some((tool) => named((tool as { name?: unknown } | undefined)?.name)) ?? false)
  );
}

/**
 * Chat-only additions for a top-level agent of a resumable chat run: the
 * follow-up suggestion section and, for the primary agent with real tools,
 * the plan tool plus its one-line instruction. Other callers (OpenAI-compatible
 * and Responses APIs, subagents) get nothing, as they have no chips or plan bar.
 */
export function buildChatGuidance({
  agent,
  appConfig,
  chat,
  primary,
}: {
  agent: GuidedAgent;
  appConfig?: AppConfig;
  /** Resumable chat caller and not a subagent. */
  chat: boolean;
  /** First top-level agent of the run (owner of the plan bar). */
  primary: boolean;
}): ChatGuidance {
  if (!chat) {
    return NONE;
  }
  const offerPlan = primary && isPlanEnabled(appConfig) && hasWorkTools(agent);
  const sections = [
    primary && isSafeWorkEnabled() ? WORK_GUIDANCE : '',
    offerPlan ? PLAN_INSTRUCTIONS : '',
    isNextStepsEnabled(appConfig) ? NEXT_STEPS_INSTRUCTIONS : '',
  ].filter((section) => section !== '');
  return {
    instructions: sections.join('\n\n'),
    tools: offerPlan ? [createPlanTool() as unknown as GenericTool] : [],
  };
}
