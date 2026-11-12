import type { LCTool } from '@librechat/agents';

export const DOCUMENT_TOOL_NAME = 'generate_document';

export const documentInstructions = `Für neue Word-, Excel- und PDF-Dateien verwende generate_document. Bei einer Benutzervorlage template_path auf den registrierten Skillpfad setzen, sonst wird das Standardlayout verwendet.
Verwende zuerst den ausdrücklich ausgewählten oder passenden aktiven Dokument-Skill des Benutzers. Seine Inhalts-, Struktur- und Vorlagenvorgaben haben Vorrang vor dem allgemeinen Standarddesign. Lies den Skill und seine benötigten Vorlagendateien; behaupte nie, eine nicht geladene Originalvorlage geprüft zu haben. Datenschutz, Berechtigungen und verbindliche Ausgabeprüfungen bleiben gültig.
Für neue wiederverwendbare Skills bevorzuge build_skill: präzise Auslöser, Eingaben, Arbeitsschritte, Grenzen und Ausgabeprüfung formulieren; ein positives und ein negatives Beispiel angeben. Originaldateien über die source_file_id des privaten Uploads bündeln. Fachliche Tests tatsächlich durchführen und Resultate vom strukturellen Paketstatus unterscheiden.
Falls build_skill nicht verfügbar ist, sichere beim manuellen Anlegen eines Word-Skills auch das unveränderte Original mit create_file(path:"skills/NAME/templates/Vorlage.docx", source_file_id:"DATEI-ID"). Eine reine SKILL.md-Datei ersetzt die Originalvorlage nicht. Nicht verfügbare Bestandteile klar als offen kennzeichnen; den Auftrag dann nicht als vollständig erledigt markieren.
Ein Ordner oder eine SKILL.md im Code-Arbeitsbereich allein ist noch kein registrierter Benutzer-Skill. Verwende den nativen create_file-Weg unter skills/NAME/ und bestätige die dauerhafte Speicherung nur nach dessen Erfolg.
Der Server setzt die freigegebenen Schriften, Farben und das Kundenlogo und prüft die exportierten Seiten.
Das Kundenlogo bleibt standardmässig enthalten. Setze include_logo nur dann auf false, wenn der Nutzer ein Dokument ohne Logo verlangt.
Erfinde keine Kennzahlen und keine Kurven. Rechenergebnisse über calculations und {{calc:ID}} einfügen.
Ein Fehler blockiert den Download. Korrigiere den genannten Punkt und versuche höchstens zweimal erneut.
Freier Code bleibt für Analyse und Datenauswertung verfügbar. Ungeprüfte PDF-, DOCX- und XLSX-Ausgaben aus freiem Code werden nicht veröffentlicht.

document ist eine JSON-Zeichenfolge. Gemeinsame Felder: title, subtitle, blocks, calculations.
Mit template_path sind zusätzlich list {items:[Text],ordered?:boolean}, metadata {rows:[[Bezeichnung,Wert]]}, signatures {rows:[[Name,Funktion]]} (höchstens drei Unterschriften), callout {title?,text,accent_color?:"#RRGGBB"} möglich. document kann footer (maximal 60 Zeichen) und numbered_headings enthalten. PDF nutzt Noto Sans als deklarierte Ersatzschrift, DOCX behält die Vorlage.
blocks enthält paragraph {text}, heading {text,level:1|2|3}, table {columns:[Spaltennamen],rows:[[Zellen]],sum_columns:[nullbasierte numerische Spalten]}, formula {latex,caption}, chart oder page_break. Jeder Baustein benötigt type.
calculations: [{id,expression,variables:{Name:Zahl},expected?,digits:2}]. Erlaubte Rechenoperationen: + - * / **, sum, min, max, sqrt. Ergebnisse im Text als {{calc:ID}} referenzieren. Dezimalpunkte verwenden; keine Währungszeichen in Recheneingaben.
chart: {type:"chart",kind:"line"|"bar"|"scatter"|"heatmap"|"fan",title,x:"Feld",y:"Feld",x_label,y_label,data:[{Feld:Wert}],series?:"Gruppenfeld",caption?}. heatmap verwendet series als Zeilenfeld; fan verwendet lower/upper als Bandgrenzen. Keine externen URLs.
Für Excel statt blocks: sheets:[{name,columns:[Spaltennamen],rows:[[Zellen]],charts?:[{kind:"column"|"bar"|"line",title,categories:"A7:A10",values:["B7:B10"],labels:["Reihe"]}]}].
Excel-Spaltenkopf ist in Zeile 6, erste Datenzeile ist Zeile 7. Eine Formelzelle ist {formula:"=SUM(B7:B9)",expected?:Zahl}. Andere Zellen sind Text, Zahl oder null. Alle Formeln werden mit LibreOffice neu berechnet; Fehler und falsche Kontrollwerte sperren die Ausgabe. Wichtige Resultate mit expected gegenprüfen. Zahleneingaben sind gelb markiert. Breite Tabellen auf mehrere Blätter verteilen, statt die Schrift zu verkleinern.
Beispiel document: {"title":"Monatsbericht","blocks":[{"type":"paragraph","text":"Der Gesamtbetrag beträgt CHF {{calc:total}}."}],"calculations":[{"id":"total","expression":"hours * rate","variables":{"hours":120,"rate":150},"expected":18000}]}`;

export const documentToolDefinition: LCTool = {
  name: DOCUMENT_TOOL_NAME,
  description:
    'Erstellt eine geprüfte Word-, Excel- oder PDF-Datei mit Kundengestaltung, optionalen Formeln und Diagrammen. ' +
    documentInstructions,
  parameters: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['pdf', 'docx', 'xlsx'] },
      filename: {
        type: 'string',
        description: 'Ein einfacher Dateiname mit passender Endung, ohne Verzeichnisse.',
      },
      document: {
        type: 'string',
        description: 'Dokumentinhalt als JSON gemäss den beschriebenen Bausteinen.',
      },
      template_path: {
        type: 'string',
        description:
          'Registrierter privater Pfad, z.B. skills/amsler/templates/Vorlage.docx. Verwendet Originalkopf, Fusszeile, Seitenlayout und Word-Schriften.',
      },
      include_logo: {
        type: 'boolean',
        description: 'Standard true. Nur bei ausdrücklichem Nutzerwunsch false setzen.',
      },
    },
    required: ['format', 'filename', 'document'],
  },
};

export const BUILD_SKILL_TOOL_NAME = 'build_skill';
export const buildSkillToolDefinition: LCTool = {
  name: BUILD_SKILL_TOOL_NAME,
  description:
    'Erstellt einen vollständigen privaten Benutzer-Skill als geprüftes Paket. Verwende dies für neue Skills für Dokumente und andere wiederkehrende Aufgaben. instructions beschreibt Auslöser, Eingaben, Ablauf, Ausgabe, Fehlerfälle und Grenzen. examples enthält mindestens einen positiven Fall und einen Nichtanwendungsfall. template_source_file_id bündelt die unveränderte private DOCX-Originaldatei, ein deterministisches Formatprofil und tatsächlich geprüfte DOCX-/PDF-Beispiele. attachments bündelt weitere eigene Uploads wie Excel, PDF, Bilder und Daten unter templates/, assets/ oder references/ über source_file_id. files bündelt zusätzliche Textressourcen oder Skripte, die ausschliesslich in der Sandbox ausgeführt werden dürfen. Ein Paketstatus behauptet keine ausgeführten fachlichen Modelltests. Eigene bestehende Skills werden nicht überschrieben.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      instructions: { type: 'string' },
      template_source_file_id: { type: 'string' },
      examples: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            expected: { type: 'string' },
            should_apply: { type: 'boolean' },
          },
          required: ['prompt', 'expected', 'should_apply'],
        },
      },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          properties: { path: { type: 'string' }, source_file_id: { type: 'string' } },
          required: ['path', 'source_file_id'],
        },
      },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    },
    required: ['name', 'description', 'instructions', 'examples'],
  },
};
