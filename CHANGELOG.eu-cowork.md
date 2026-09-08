# EU-Cowork: Änderungen am LibreChat-Fork

## Noch nicht veröffentlicht – 8. September 2026

- Eine linke Navigation bündelt Aktionen, Projekte und Chats. Verwaltungsbereiche
  lassen sich je Rolle ausblenden, ohne die Nutzung freigegebener Werkzeuge zu entziehen.
- Die Sitzungsübersicht zeigt verwendbare Dateien, Ergebnisse und protokollierte
  Werkzeuge. Originaldownloads verwenden die vorhandenen authentifizierten Dateirouten.
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

Die Änderungen sind lokal geprüft und noch kein veröffentlichter Fork-Commit oder
gepinntes Release-Image. Testfälle, Browserbelege und verbleibende Betriebsgrenzen
stehen im Monorepo unter `docs/ux/premium-chat-abnahme-2026-09.md`.
