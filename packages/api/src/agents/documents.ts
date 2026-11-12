import type { LCTool } from '@librechat/agents';

export const DOCUMENT_TOOL_NAME = 'generate_document';

export const documentInstructions = `Für neue Word-, Excel- und PDF-Dateien verwende generate_document.
Verwende zuerst den ausdrücklich ausgewählten oder passenden aktiven Dokument-Skill des Benutzers. Seine Inhalts-, Struktur- und Vorlagenvorgaben haben Vorrang vor dem allgemeinen Standarddesign. Lies den Skill und seine benötigten Vorlagendateien; behaupte nie, eine nicht geladene Originalvorlage geprüft zu haben. Datenschutz, Berechtigungen und verbindliche Ausgabeprüfungen bleiben gültig.
Wenn eine hochgeladene Word-Datei als Skill gespeichert werden soll, sichere auch das unveränderte Original mit create_file(path:"skills/NAME/templates/Vorlage.docx", source_file_id:"DATEI-ID"). Eine reine SKILL.md-Datei ersetzt die Originalvorlage nicht. Nicht verfügbare Bestandteile klar als offen kennzeichnen; den Auftrag dann nicht als vollständig erledigt markieren.
Ein Ordner oder eine SKILL.md im Code-Arbeitsbereich allein ist noch kein registrierter Benutzer-Skill. Verwende den nativen create_file-Weg unter skills/NAME/ und bestätige die dauerhafte Speicherung nur nach dessen Erfolg.
Der Server setzt die freigegebenen Schriften, Farben und das Kundenlogo und prüft die exportierten Seiten.
Das Kundenlogo bleibt standardmässig enthalten. Setze include_logo nur dann auf false, wenn der Nutzer ein Dokument ohne Logo verlangt.
Erfinde keine Kennzahlen und keine Kurven. Rechenergebnisse über calculations und {{calc:ID}} einfügen.
Ein Fehler blockiert den Download. Korrigiere den genannten Punkt und versuche höchstens zweimal erneut.
Freier Code bleibt für Analyse und Datenauswertung verfügbar. Ungeprüfte PDF-, DOCX- und XLSX-Ausgaben aus freiem Code werden nicht veröffentlicht.

document ist eine JSON-Zeichenfolge. Gemeinsame Felder: title, subtitle, blocks, calculations.
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
      include_logo: {
        type: 'boolean',
        description: 'Standard true. Nur bei ausdrücklichem Nutzerwunsch false setzen.',
      },
    },
    required: ['format', 'filename', 'document'],
  },
};
