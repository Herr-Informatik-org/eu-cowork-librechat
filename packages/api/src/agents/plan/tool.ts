import { z } from 'zod';
import { tool } from '@librechat/agents/langchain/tools';
import {
  PLAN_MAX_STEPS,
  PLAN_TOOL_NAME,
  EModelEndpoint,
  parsePlanArgs,
  countDoneSteps,
  PLAN_STEP_MAX_CHARS,
  PLAN_TITLE_MAX_CHARS,
} from 'librechat-data-provider';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { AppConfig } from '@librechat/data-schemas';

const PLAN_TOOL_DESCRIPTION = [
  'Zeigt den Plan des aktuellen Auftrags als Checkliste über dem Eingabefeld an und führt ihn nach.',
  'Nur bei Aufträgen mit drei oder mehr Arbeitsschritten verwenden: zuerst aufrufen, dann nach',
  'jedem erledigten Schritt erneut mit der vollständigen Liste. Genau ein Schritt hat den Status',
  "'laeuft'. Kurze Schritte in der Sprache der Person, ohne IDs oder Werkzeugnamen. Setzt eine",
  'Nachricht einen früheren Plan fort, übernimm ihn angepasst; sonst beginne ohne alten Plan.',
  'Nicht parallel zu anderen Werkzeugen aufrufen, die vom Ergebnis abhängen.',
].join(' ');

export const planToolSchema: z.ZodObject<
  {
    titel: z.ZodOptional<z.ZodString>;
    schritte: z.ZodArray<
      z.ZodObject<
        { schritt: z.ZodString; status: z.ZodEnum<['offen', 'laeuft', 'erledigt']> },
        'strip'
      >,
      'many'
    >;
  },
  'strip'
> = z.object({
  titel: z
    .string()
    .max(PLAN_TITLE_MAX_CHARS * 2)
    .optional()
    .describe('Kurzer Titel des Auftrags (optional).'),
  schritte: z
    .array(
      z.object({
        schritt: z
          .string()
          .min(1)
          .max(PLAN_STEP_MAX_CHARS * 2)
          .describe('Kurzer Arbeitsschritt, höchstens 80 Zeichen.'),
        status: z.enum(['offen', 'laeuft', 'erledigt']),
      }),
    )
    .min(1)
    .max(PLAN_MAX_STEPS)
    .describe('Alle Schritte des Auftrags in Reihenfolge.'),
});

export type PlanToolInput = z.infer<typeof planToolSchema>;

/** Short tool result: confirms the update without echoing the plan back into context. */
export function describePlanUpdate(input: PlanToolInput): string {
  const plan = parsePlanArgs(input);
  if (!plan) {
    return 'Plan nicht gespeichert: keine gültigen Schritte.';
  }
  const done = countDoneSteps(plan);
  const total = plan.steps.length;
  if (done === total) {
    return `Plan gespeichert: alle ${total} Schritte erledigt.`;
  }
  return `Plan gespeichert: ${done} von ${total} Schritten erledigt. Arbeite den nächsten Schritt ab.`;
}

/**
 * The `plan_aktualisieren` host tool. It has no side effects: its arguments are
 * the plan, streamed with the message and persisted in its content, where the
 * client's plan bar and the server's stop reminder read them.
 */
export function createPlanTool(): DynamicStructuredTool<typeof planToolSchema> {
  return tool(async (input: PlanToolInput) => describePlanUpdate(input), {
    name: PLAN_TOOL_NAME,
    description: PLAN_TOOL_DESCRIPTION,
    schema: planToolSchema,
  });
}

/** One line of system text that ties the plan tool to multi-step work. */
export const PLAN_INSTRUCTIONS =
  'Bei Aufträgen mit drei oder mehr Arbeitsschritten führst du einen sichtbaren Plan mit plan_aktualisieren, arbeitest ihn vollständig ab und prüfst jedes Ergebnis, bevor du einen Schritt als erledigt markierst.';

/** The plan tool is offered in the chat unless `endpoints.agents.plan` is `false`. */
export function isPlanEnabled(appConfig?: AppConfig): boolean {
  return appConfig?.endpoints?.[EModelEndpoint.agents]?.plan !== false;
}
