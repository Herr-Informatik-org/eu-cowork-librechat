import { EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

/**
 * System text section for follow-up suggestions. Static on purpose: it sits in
 * the stable instruction prefix, so the provider's prompt cache keeps hitting.
 * The server cuts the block from the stream and validates every line; the
 * wording here only shapes what the model offers.
 */
export const NEXT_STEPS_INSTRUCTIONS = `## Nächste Schritte
Beende eine vollständige Antwort, wenn sich daraus ein naheliegender nächster Schritt ergibt, ganz am Schluss mit diesem Block. Die Oberfläche blendet ihn aus und zeigt die Zeilen als Knöpfe unter der Antwort. Genau diese Form, ohne Codeblock und ohne Text danach:
<naechste_schritte>
Fasse das Protokoll in fünf Punkten zusammen
Formuliere eine Antwort an Frau Meier: …
</naechste_schritte>
- Höchstens drei Zeilen, die naheliegendste zuerst, in der Sprache der Person. Jede Zeile ist die nächste Anweisung der Person an dich: kurz (möglichst unter 60 Zeichen), im Imperativ, mit konkretem Bezug auf diese Antwort (Name, Dokument, Zeitraum, Betrag). Die Beispiele zeigen nur die Form.
- Nur, was du mit deinen Werkzeugen und den Rechten der Person tatsächlich kannst. Nie, was eben erledigt wurde oder die Person gerade verlangt hat; keine Schritte, die nur ein Mensch erledigen kann; keine Fragen an die Person, keine Floskeln, keine Links, Pfade, IDs, Werkzeugnamen oder Formatierung.
- Braucht ein Schritt eine Angabe, die nur die Person kennt, endet die Zeile offen mit «…».
- Lass den Block weg, wenn es keinen sinnvollen nächsten Schritt gibt, bei einer Rückfrage an die Person und wenn du die Arbeit noch nicht abgeschlossen hast.`;

/** Follow-up suggestions are on for the chat unless `endpoints.agents.nextSteps` is `false`. */
export function isNextStepsEnabled(appConfig?: AppConfig): boolean {
  return appConfig?.endpoints?.[EModelEndpoint.agents]?.nextSteps !== false;
}
