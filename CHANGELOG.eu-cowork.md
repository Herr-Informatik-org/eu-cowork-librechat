# EU-Cowork: Änderungen am LibreChat-Fork

## 2026-10-27 — Mailaufträge und abgesicherte HTML-Vorschau für CW01

- Einzelne oder bis zu 100 ausdrücklich ausgewählte Originalmails werden als
  gespeicherter Hintergrundauftrag verschoben. Die Oberfläche zeigt den Fortschritt
  und bleibt für andere Mails bedienbar. Die Analyse gibt manuelle Aufträge zwischen
  einzelnen Mails frei; unnötig serielle Ordnerabfragen entfallen.
- Offene Antwortbearbeitungen bleiben bei automatischer Listenaktualisierung und
  beim Wechsel zu anderen Mails im Arbeitsspeicher erhalten. Vor dem Verschieben
  einer gerade bearbeiteten Mail muss ihr Entwurf gespeichert oder die Bearbeitung
  abgebrochen werden.
- Aufträge bleiben an Benutzer, persönliche Verbindung und bestätigte
  Auswahlversionen gebunden. Pause und geänderte Freigaben stoppen offene Einträge;
  unklare Schreibausgänge werden nach einem Neustart nicht ungeprüft wiederholt.
- HTML-Mails erscheinen mit erlaubter Formatierung in einer doppelt bereinigten,
  isolierten Vorschau. Skripte, Formulare, aktive Links und externe Bilder bleiben
  gesperrt. Unterstützte eingebettete Rasterbilder werden begrenzt und neu kodiert.
- Manipulierte Modellantworten dürfen keine Werkzeuge oder Postfachaktionen
  vorgeben. Versand bleibt ausschliesslich beim Mitarbeiter in Outlook.

## 2026-10-27 — Persönlicher Mailbereich für CW01

- Neue Webansicht mit Suche, Prioritäts- und Erledigt-Filtern, eigener Ordnerauswahl,
  Klartextvorschau und geschützter Entwurfsbearbeitung. Ein neuer Chat übernimmt
  den gewählten Kontext nur flüchtig und sendet ihn nicht ungefragt ab.
- Einzelne Originalmails lassen sich nach ausdrücklicher Bestätigung in einen
  eigenen bestehenden Ordner verschieben. Auswahlversion, Benutzerbindung,
  atomare Sperren und Audit schützen manuelle Änderungen auch bei pausierter KI.
- Neue Antwortentwürfe erhalten den nativen zitierten Verlauf, Kategorien und
  kopierte Dateianhänge. Dateien gelangen nicht zum Modell. Nicht unterstützte
  Anhänge und unklare Schreibausgänge werden sichtbar; vorhandene Entwürfe werden
  nicht ungefragt nachgerüstet oder überschrieben. Es gibt keinen Sendeaufruf.
- Gewählte Prüfungen laufen in gespeicherten 20er-Paketen bis zum Ende weiter;
  Pause, geänderte Einstellungen, Fehler und die geplanten Arbeitszeiten stoppen
  die Fortsetzung. Bestehende Freigaben benötigen die persönliche Bestätigung
  der erweiterten Verarbeitung vom 27.10.2026.
- Die Webliste lädt alle innerhalb von 30 Tagen erhaltenen Ergebnisse seitenweise.
  Statt der früheren stillen 200-Ergebnis-Verdrängung hält ein Speicherlimit die
  Verarbeitung sichtbar an. Freigabe weiterhin ausschliesslich intern für CW01.
- Die Aufbewahrungsprüfung lässt Mailaufträge ohne Ergebnisse unverändert;
  dadurch bleibt die Zustandsprüfung beim CW01-Update zuverlässig.

## 2026-10-26 — Mail-Vorgang persönlich zur Überarbeitung öffnen

- Der Mail-Assistent kann die eigene Originalmail und einen weiterhin gültigen
  Antwortentwurf gezielt als Textvorschau bereitstellen. Nur gespeicherte eigene
  Ergebniskennungen werden akzeptiert; persönliche Zustimmung, Kontoberechtigung
  und dieselbe Postfachverbindung werden vor und nach dem Abruf geprüft.
- Inhaltsfreie Vorab-Protokollierung und feste lesende Graph-Abfragen schützen
  diesen Weg. Es wird keine automatische Mailprüfung oder Modellanfrage gestartet;
  die Vorschau speichert oder verändert keine Postfachinhalte. Veraltete, fehlende oder
  bereits gesendete Entwürfe werden nicht als verfügbare Entwürfe ausgegeben.

## 2026-10-26 — Microsoft-Folgeseiten beim Mail-Verlauf lesen

- Die rückwirkende Posteingangsprüfung akzeptiert von Microsoft gelieferte
  Folgeseiten mit aufgelöster Ordner-ID und OData-Klammerform. Die erste Seite
  wird dadurch bei grösseren Posteingängen nicht mehr vor der Verarbeitung verworfen.
- Zielhost, eigenes Postfach, Nachrichten-Sammlung und sichere Pfadsegmente bleiben
  geprüft; andere bekannte Ordnernamen und manipulierte Links werden abgewiesen.
  Eine nicht sicher prüfbare Folgeseite wird als solche gemeldet.

## 2026-10-26 — Freiwillige Prüfung bestehender Eingangsmails

- Persönliche Einstellungen erlauben eine rückwirkende Prüfung seit einem Datum
  in der gewählten Zeitzone oder für den gesamten bestehenden Posteingang. Standard bleibt aus.
- Separater verschlüsselter Fortschritt ergänzt die laufende Prüfung neuer Eingänge.
  Der historische Zeitraum endet unveränderlich bei der ersten persönlichen Aktivierung;
  pro Aufruf werden höchstens 20 Nachrichten verarbeitet. Nach vier Minuten beginnt
  keine weitere Nachricht; ein bereits laufender Aufruf kann länger dauern.
  Neue und bestehende Eingänge wechseln sich bei der Vorrangigkeit ab, damit langsame
  Modellantworten keine der beiden Prüfungen dauerhaft aufhalten.
- Offene Folgeseiten und historische Fortschritte werden ausdrücklich angezeigt.
  Pausen, Kontobindung, persönliche Freigabe, Schutz vorhandener Entwürfe und Versandverbot
  gelten unverändert; zusätzliche Microsoft-Berechtigungen werden nicht benötigt.

## 2026-10-25 — Freiwilliger persönlicher Mail-Assistent

- Neue Office-API für eigene Microsoft-Postfachverbindung, ausdrückliche persönliche
  Freigabe, manuelle Ausführung und Arbeitszeitplanung; zunächst nur intern auf CW01.
- Kategorien und Antwortentwürfe entstehen über begrenzte Graph-Operationen. Es gibt
  keinen Versand-, Lösch- oder Verschiebeweg. Vorhandene Entwürfe werden nicht verändert.
- Persönlicher OAuth-Ablauf mit PKCE, Kontoabgleich und verschlüsselten, benutzergebundenen
  Zugangsdaten. Modellroute, Konto und Freigabe werden vor jedem Schritt erneut geprüft.
- Eine bestehende Entra-App kann erweitert werden. Bereits freigegebene delegierte
  Lesezugriffe auf Mail, Kalender, Aufgaben, Dateien und Sites werden bei Anmeldung und
  Erneuerung zusätzlich toleriert; angefordert bleiben nur `User.Read`, `Mail.ReadWrite`
  und `offline_access`. Zusätzliche Schreib-, Versand- und Shared-Postfachrechte bleiben gesperrt.
- Das konfigurierte Standardmodell wird vor der persönlichen Freigabe angezeigt
  und bei zentralen Änderungen automatisch übernommen. Keine Ersatzroute bei Fehlern.
- Verschlüsselte persönliche Hinweise mit 30 Tagen Aufbewahrung, atomare Auftragssperren,
  dauerhafter Schutz vor unklaren doppelten Entwurfsversuchen und verpflichtendes Audit.
  Kontolöschung und Trennung entfernen die persönlichen Assistentendaten.

## 2026-10-05 — Bestehende Microsoft-Zustimmung bei MCP-Anmeldung nutzen

- Im explizit administrativ konfigurierten Microsoft-Graph-Modus wird keine erneute
  Zustimmung durch `prompt=consent` erzwungen. Entra kann vorhandene
  Administratorfreigaben nutzen und prüft weiterhin die angeforderten Berechtigungen.
- `offline_access`, persönliche Anmeldung, State und PKCE bleiben erhalten.
  Andere OAuth-Anbieter und die dynamische MCP-Registrierung bleiben unverändert.

## 2026-10-04 — Direkte Microsoft-Graph-Anmeldung für interne MCP-Server

- Administrativ konfiguriertes `oauth.resource_mode: microsoft_graph` lässt den
  OAuth-Parameter `resource` bei Anmeldung, Code-Austausch und Token-Erneuerung weg.
  Das behebt `invalid_target` bei Entra-v2-Endpunkten mit interner MCP-Adresse.
- Der Modus setzt explizite Entra-Endpunkte desselben Mandanten, eine Client-ID und
  Graph-Berechtigungen voraus. Persönlich angelegte Server können ihn nicht setzen.
- Die interne MCP-Adresse bleibt an Ressourcenmetadaten und gespeicherte Anmeldungen
  gebunden. Moduswechsel und unvollständige Altbestände erfordern eine neue Anmeldung.

## 2026-09-28 — Outlook-Transport mit nativer Chat-Persistenz

- Persönliche Outlook-API-Schlüssel erhalten einen eng begrenzten Transport für
  die bestehenden Chat-, Stream- und Verlaufsfunktionen. Web-JWT-Routen bleiben
  bestehen; Outlook erhält keine Agentenverwaltung.
- Modellkarten kommen aus der effektiven Benutzerkonfiguration. Endpunkt, Modell
  und private Anweisungen bestimmt der Server; Clientüberschreibungen werden abgelehnt.
- Chats, Elternnachrichten, Bilddateien und Streams bleiben an Benutzer und Mandant
  gebunden. Bilder verwenden die bestehende Upload-Pipeline und deren Grenzen.
- Konfigurierbare Pflichtbestätigungen für MCP-Werkzeuge gelten auch bei sonst
  erteilten Dauerfreigaben. Nicht bestätigungsfähige Ausführungspfade werden gesperrt.
  Persönliche Aliase geschützter HTTP-Connectoren können die Regel nicht entfernen;
  verwaltete Kopien derselben Adresse übernehmen die Pflichtregeln.

## 2026-09-16 — Nur freigegebene MCP-Verbindungen anzeigen

- Gateway-Verbindungen anhand der bestehenden Admin-Regeln pro Benutzer filtern;
  Listen, Werkzeuge, Status und einzelne Serverabfragen verwenden dieselbe Sicht.
- Aktuelle Gateway-Freigabe nach dem Konfigurationscache prüfen. Fehler blenden
  die betroffene Verbindung aus; direkte OAuth-Verbindungen bleiben erhalten.
- Entzogene Verbindungen aus der aktiven Auswahl entfernen, auch beim Entzug aller
  Freigaben. Während der ersten Ladephase gespeicherte Einstellungen erhalten.
- Benötigt das passende MCP-Gateway mit internem Berechtigungsendpunkt.

## 2026-09-15 — Brain-Neuaufbau live anzeigen und automatisch übernehmen

- Vor einem neuen Neuaufbau die automatische Übernahme und Modellkosten
  bestätigen. Die Zustimmung beim Auftrag erhalten; ältere Entwürfe bleiben manuell.
- Fertige, geprüfte Ergebnisse serverseitig übernehmen, auch bei geschlossenem
  Browser. Pausen, entzogene Berechtigungen und verlorene Abschlussantworten absichern.
- Den wachsenden Entwurf in Wissenskarte, Liste und Detailansicht anzeigen.
  Entwurfsansichten schreibgeschützt halten und nach Abschluss zum aktiven Brain wechseln.

## 2026-09-15 — Grosse Brain-Verläufe automatisch verarbeiten

- Gespräche über 2’000 Beiträge und Einzeltexte über 120’000 Zeichen automatisch
  in begrenzten Modellabschnitten analysieren. Die Schlussprüfung berücksichtigt
  den gesamten Verlauf samt späteren Korrekturen und speichert ihren Fortschritt.
- Umfangreiche Quellenmetadaten einmalig in geprüften Seiten übertragen; pro
  Erinnerung nur Belege und Verweis auf die vollständige Herkunft senden.
  Bestehende Importzwischenstände und Kennungen gültiger Teilpakete erhalten.
- Anhänge und Werkzeugausgaben schon beim Datenbanklesen ausschliessen, ohne
  sichtbare Textteile, Quellenhashes oder Reihenfolge zu verändern.
- Synthetische Regressionen für beide bisherigen Grössenlimits, späte Korrekturen,
  wiederholte Kurzbelege, Wiederaufnahme und den gemeinsamen Brain-Dienstvertrag.

## 2026-09-15 — Brain-Speicherung und Fehlerdiagnose korrigieren

- Leere optionale Modellfelder beim Speichern und Fortsetzen bereinigen;
  ungültige Aussagen und Belege weiterhin ausschliessen. Datumsgrenzen anhand
  tatsächlicher Zeitpunkte prüfen. Gültige Anfragen behalten ihre Wiederholungskennung.
- HTTP 400 des Brain-Dienstes als Datenablehnung statt Verbindungsverlust melden.
  Feste Dienstcodes, Feldnamen und Prüfgründe erreichen die Admin-Ansicht;
  Antworttexte bleiben ausgeschlossen, Fehlerantworten auf 4 KiB begrenzt.
- 192 Brain-Prüfungen und API-Bau erfolgreich. Der konkrete interne Zwischenstand
  muss auf der Zielinstanz geprüft werden; keine echten Modellanfragen ausgeführt.

## 2026-09-15 — Zentrale Modellkarten trotz Gruppen- und Rollenauswahl

- Gespeicherte Kartenkopien in Gruppen, Rollen und Benutzerregeln werden nur noch
  als Namensauswahl ausgewertet. Herkunft, Modellroute, Prompt und weitere Felder
  kommen aus dem aktuellen zentralen Katalog (YAML plus Basis-Override).
- Die höchstpriorisierte Auswahl gewinnt weiterhin; zentrale Reihenfolge und
  gültiger Standard bleiben erhalten. Entfernte Karten verschwinden, neue Karten
  erweitern keine eingeschränkte Auswahl. Bestehende Regeln benötigen keine Migration.
- 95 Prüfungen zur Konfigurationskaskade, Benutzerkonfiguration und öffentlichen
  Menüantwort erfolgreich, einschliesslich der GL-Auswahl ohne Astra und einer
  zentralen Änderung nach Cache-Invalidierung. Datenbibliothek gebaut und typgeprüft.
- Lokale Fehlerkorrektur; für die interne Instanz ist ein neues Chat-Image erforderlich.

## 2026-09-15 — Desktop-Benachrichtigungen für fertige Antworten

- Neuer Schalter unter Einstellungen → Allgemein → Barrierefreiheit. Einmalige
  Browserfreigabe, Einstellung je Benutzer und Browser.
- Fertige Antworten melden sich nur bei verborgenem Chat-Tab oder Browserfenster
  ohne Fokus. Ein Klick öffnet den zugehörigen Chat; die Meldung enthält weder
  Chat-Titel noch Antworttext.
- Abgebrochene, fehlerhafte und unvollständige Antworten lösen keine Meldung aus.
  Wiederholte Abschlussereignisse werden unterdrückt; bestätigte Abschlüsse nach
  Wiederverbindung werden berücksichtigt.
- Verifiziert mit 116 automatisierten Tests, Typprüfung, Lint, Frontend-Build
  und einem lokalen Chrome-Ablauf mit simuliertem Modell und kontrolliertem
  Hintergrundzustand. Die tatsächliche Betriebssystem-Banneranzeige bleibt
  Teil der Zielinstanz-Abnahme.
- Lokale Umsetzung im Fork. Für bestehende Instanzen ist ein neues Chat-Image
  erforderlich; kein Produktivrollout mit dieser Änderung.

## 2026-09-14 — Brain lernt aus zusammenhängenden Gesprächen

- Gesprächsanalyse berücksichtigt Benutzerreaktionen, Assistentenvorschläge,
  Korrekturen und den jeweiligen Projekt- oder Kundenbezug. Eigenständige
  Wissensaussagen behalten genaue Belege und werden vor der Übernahme geprüft.
- Getrennte Modelle für Erstaufbau und laufendes Lernen; optionaler versionierter
  Unternehmenskontext und freigegebene Verbindungsnamen als schwache Hinweise.
- Neuaufbau mit getrenntem Entwurf, Vorschau, bewusster Übernahme und befristeter
  Rückkehr. Manuelle Änderungen und Löschentscheidungen bleiben geschützt.
- Gesprächsabschnitte werden mit Zwischenstand verarbeitet; wiederholtes Starten
  setzt den Fortschritt nicht zurück. Direkte Chatbefehle können ihren Bezug aus
  dem aktuellen Gespräch erhalten.
- Bestehende interne Daten bleiben bis zu einem bewusst gestarteten Neuaufbau
  erhalten. Keine Modellevaluierung und kein Produktivrollout ausgeführt.

## 2026-09-14 — Brain-Zeitlimit und Fehlerdiagnose

- Langsame gültige Lernaufrufe dürfen standardmässig bis zu 120 Sekunden benötigen.
- Importfehler werden mit unterscheidbarer Ursache und Referenz angezeigt und lokal für die Admin-Ansicht protokolliert. Auch automatisches Lernen und Brain-Anfragen liefern Diagnoseereignisse.
- Rohfehler und Quelltexte bleiben ausserhalb des Protokolls; eine gestörte Protokolldatenbank blockiert die Fehlerbehandlung nicht.

## 2026-09-14 — Persönliches Brain mit Chatverlauf und Chatbefehlen

- Persönliches Gedächtnis mit adaptivem Abruf, belegten Quellen und automatischem
  Lernen aus eigenen Chatbeiträgen; getrennt je Benutzer.
- Wissenskarte im bestehenden hellen und dunklen Design ersetzt das persönliche
  Memory-Panel. Erinnerungen lassen sich suchen, bearbeiten, vergessen und exportieren.
- Auf Wunsch aus bisherigen eigenen Chats lernen, mit gespeichertem Fortschritt,
  Pause und Fortsetzen. Speichern, gezieltes Korrigieren und Vergessen sind auch
  direkt im normalen Chat möglich.
- Ein separates Hintergrundmodell ist konfigurierbar. Temporäre Chats, Opt-out,
  Berechtigungen, Quellenlöschung und persönliche Budgets werden berücksichtigt.
- Verifiziert mit 80 API- und 89 Oberflächentests, API-Bündelung, Frontend-Build sowie
  fünf lokalen Browserabläufen mit simuliertem Modellanbieter. Der separate
  Brain-Dienst benötigt die passende Distribution; kein Produktivrollout.

## 2026-09-14 — Verarbeitungsregion auf Modellkarten

- Kennzahl «Verarbeitung» neben Intelligenz und Tokenkosten, auch in Suchergebnissen.
- Schweizer Wappen und Europasymbol in Originalfarben, alle Icons einheitlich 14 Pixel.
- Optionales Regionsfeld im Schema; fehlende Angaben erscheinen als «Unbekannt».
- 21 Schema-/Komponententests, vollständiger Typecheck, Lint, Build und lokale
  Browserprüfung des Menüs und der Suche bei Desktop- und Mobilbreite erfolgreich.

## 2026-09-14 — Bildnachrichten ohne Pflichttext

- Fertig hochgeladene Bilder lassen sich direkt senden, auch bei leerem Textfeld.
  Bestehende Nachrichten und der Bezug zur letzten Antwort bleiben erhalten;
  es wird kein künstlicher Begleittext eingefügt.
- Unfertige Uploads und leere Entwürfe ohne Bild bleiben gesperrt. Erneutes
  Generieren verwendet die Bilder der ursprünglichen Nachricht.
- Geprüft mit 29 Tests des Nachrichtenversands, Typecheck, Lint, Frontend-Build
  und einem echten lokalen Sol-Supportchat mit künstlichem Fehler-Screenshot.
  Auch ein neuer Chat mit «Automatisch» nimmt das Bild per Enter an. Der gespeicherte
  Bildbeitrag enthält leeren Text und bleibt nach Neuladen sichtbar.

## 2026-09-14 — Bildvorschau in der Dateiliste

- Bilddateien aus dem Sitzungskontext öffnen eine echte Vorschau mit Zoom,
  Rücksetzen, Pixelgrösse und Originaldownload. PNG, JPEG, GIF, WebP, AVIF,
  BMP, ICO und SVG werden anhand von Dateityp oder Endung erkannt.
- Die Vorschau nutzt weiterhin den berechtigten Dateidownload. SVG wird als
  Bild dargestellt; fremde Inhalte werden nicht als HTML eingebettet.
- Abgebrochene Ladevorgänge liefern beim erneuten Öffnen keine veralteten
  Ergebnisse. Temporäre Vorschau-URLs werden beim Schliessen freigegeben.
- Geprüft mit 17 Regressionstests, Typecheck, Lint sowie einem echten lokalen
  PNG-Upload und Browserprüfung auf Desktop und Mobilbreite.

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
