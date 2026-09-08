# EU-Cowork: Änderungen am LibreChat-Fork

## Änderungen – 8. September 2026

- Der rechte Arbeitsbereich hat drei Zustände: ausgeblendet, kompakte Kontextkachel
  und Dokument. Der Toggle behält die ausgewählte Datei beim Zuklappen; X schliesst
  sie zurück zur Kachel. Eine grosse reine Kontextliste entfällt, auch mobil.
- Die Dokumentansicht fährt mit einer 240-ms-Kurve sanft ein. Reduzierte Bewegung
  vermeidet das Verschieben. Der irreführende dateiübergreifende Versionsbutton und
  «Back to session» entfallen; die Office-Ansicht erklärt ihren Vorschaucharakter kurz.
- Lange Chat-Titel laufen nach 300 ms Hover mit lesbarer Geschwindigkeit nach links.
  Nachrichtenmarkierungen neben dem Verlauf entfallen, der Scrollbar-Hintergrund ist
  transparent. Das Artifacts-Dropdown passt optisch zum benachbarten Schalter.


- Eine linke Navigation bündelt Aktionen, Projekte und Chats. Verwaltungsbereiche
  lassen sich je Rolle ausblenden, ohne die Nutzung freigegebener Werkzeuge zu entziehen.
- Dateien und tatsächlich verwendete Skills erscheinen in einer kompakten Box rechts
  oben im Chat. Ein geöffnetes Seitenpanel oder eine Dokumentvorschau ersetzt die Box.
  Dateizeilen öffnen Vorschauen direkt; separate Download-Icons liefern die Originale
  über vorhandene authentifizierte Dateirouten. Auf kleinen Displays bleibt das Panel
  über den Chatkopf erreichbar. Lange Chats behalten ihr sichtbares Eingabefeld.
- Die eingeklappte Navigation zeigt dieselben Hauptaktionen wie die ausgeklappte.
  Provider-Icons und der seitliche Auswahlstrich entfallen in der Chatliste.
- DOCX, XLSX/XLS/ODS und PPTX erhalten eine echte PDF-Vorschau über einen optionalen
  isolierten Office-Renderer. Originale bleiben unverändert; private Vorschauen prüfen
  Berechtigungen vor jedem Zugriff und begrenzen Dateigrösse, Laufzeit und Cache.
- Chatstatus unterscheidet Warten, Verarbeitung, Rückfrage, Abschluss, Fehler und
  Abbruch. Beobachtete Endzustände bleiben benutzerbezogen im aktuellen Browser-Tab
  über Reload erhalten. Historischen Chats wird kein Abschlusszustand unterstellt.
  Wechselnde Antwort-IDs während SSE-Arbeitsschritten werden nachgeführt, damit
  die Anzeige auch bei laufender Werkzeugnutzung und Textausgabe aktuell bleibt.
- Uploadmodi erklären Dateiverwendung und Folgen. Strukturierte Rückfragen nutzen
  LibreChats vorhandenen Dialog- und Fortsetzungspfad. Animationen beachten reduzierte
  Bewegung; die Dokumentfläche bleibt unabhängig vom Chattheme hell.
- Die Websuche erhält eine explizite Wahl ohne Zeitfilter sowie eine ehrliche
  Rückmeldung bei leeren Ergebnissen. Modell- und Ausführungsdefinition bleiben synchron.
  Das gilt auch für kombinierte Inhalts-/Quellenantworten; die Quellen bleiben erhalten.

Die Änderungen sind lokal geprüft. Der Produktions-Image-Digest wird separat nach
Freigabe angehoben. Testfälle und Betriebsgrenzen stehen im Monorepo unter
`docs/ux/premium-chat-abnahme-2026-09.md` und
`docs/ux/chat-workspace-refinement-2026-09.md`.
