# EU-Cowork: Änderungen am LibreChat-Fork

## 2026-09-11 — Modellkarten und gehostetes Testguthaben

- Modellkarten zeigen relative Leistungs- und Kostenstufen mit fünf Symbolen sowie
  Eingabearten. Alle vier kuratierten Karten bleiben im Menü übersichtlich sichtbar.
- Gehostete Instanzen prüfen das gemeinsame Testguthaben vor Modellanfragen und an
  Agenten-Fortsetzungsgrenzen. Bei fehlender Verbrauchsprüfung bleibt Inferenz gesperrt.
- Native Konfigurationsänderungen gehosteter Modellzugänge brauchen die signierte
  Betreiberverbindung; Selbstbetrieb bleibt unverändert.
- Verifiziert mit Middleware-Regressionstests, API-/Frontend-Build und echten lokalen
  Modellantworten; Kosten bereits laufender Provideranfragen können noch nachlaufen.

## 2026-09-09 — Nachrichtennavigation links im Chat

- Die Sprungnavigation ist auf Desktop wieder sichtbar, nun am linken Rand des Chatbereichs. Marker, Pfeile und Textvorschau sind entsprechend gespiegelt. Der Nachrichteninhalt erhält Platz für die Leiste; auf schmalen Mobilansichten bleibt sie ausgeblendet.
- Bestehende Tastatur-, Scroll- und Drag-Navigation bleibt erhalten. Verifiziert mit 72 Navigationstests, Typecheck, Frontend-Build und lokaler Browserprüfung.

## 2026-09-08 — Ergebnisliste ohne interne Arbeitsdateien

- Code-Ausgaben unter `_work/` bleiben in der temporären Ausführungssitzung und werden nicht in den dauerhaften Chat-Dateispeicher kopiert. Fertige Ausgaben ausserhalb dieses reservierten Ordners bleiben unverändert.
- Mit `read_file` betrachtete Kontrollbilder werden dem Modell weiterhin übergeben, aber nicht nochmals als generierte Bildanhänge gespeichert. Dies gilt für Chat-Completions und Responses.
- Verifiziert mit 136 API-Tests; bestehender lokaler Herr-DCF-Testchat von 25 internen Anhängen bereinigt, Originale und Endergebnisse erhalten.


## 2026-09-08: Originaldarstellung und einheitliche Dateiöffnung

- Tabellen behalten schmale Spalten, Zeilenhöhen und Schriftarten statt die Vorschau künstlich zu strecken.
- Hochgeladene Office-Dateien öffnen auch direkt aus einer Chatnachricht die private Dokumentansicht. OpenXML wird nicht länger als Text interpretiert; Freigaben bleiben getrennt.
- PDFs zeigen keine redundante Dokumenttyp-Zeile.
- Geprüft: zwölf Komponentenprüfungen einschliesslich des reproduzierten XLSX-Klickfehlers, Typecheck und Build.

## 2026-09-08: Grosse Arbeitsmappen Blatt für Blatt öffnen

- Die interaktive Tabellenansicht lädt das gewählte Blatt nach und behält alle verfügbaren Tabs.
- Ungültige Blattnummern werden vor dem Renderer-Aufruf abgewiesen.
- Geprüft mit 33 API- und vier Komponentenprüfungen, Typecheck, Build und einer lokalen Mappe mit 17 Blättern.

## Änderungen – 8. September 2026

- XLSX, XLS und ODS öffnen eine helle Tabellenansicht mit auswählbaren Zellen,
  Formelzeile und Blatt-Tabs. Die Darstellung ist schreibgeschützt und lädt Daten
  ausschliesslich über die authentifizierte Dateiroute und den lokalen Renderer.
- PDF-Dateien lassen sich direkt in der Dokumentansicht öffnen. Originaldownload
  und Dateiberechtigungen bleiben erhalten.
- Eigene Nachrichten stehen rechts in einer Textblase; lange Inhalte lassen sich
  auf- und zuklappen. Absender und Modellüberschriften sind nur noch für Screenreader
  vorhanden. Der Artifacts-Schalter hat einen durchgehenden Rahmen.
- Auch das Ausblenden des Arbeitsbereichs wartet nun die Ausfahranimation ab.
  Schnelles Wiederöffnen unterbricht den Vorgang und behält die ausgewählte Datei.


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
