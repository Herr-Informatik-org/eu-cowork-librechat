const mongoose = require('mongoose');
const {
  provisionSupportRuntime,
  disableSupportRuntime,
  SupportProvisionError,
} = require('@librechat/api');

async function main() {
  const input = process.argv.slice(2);
  const disable = input[0] === '--disable';
  const args = disable ? input.slice(1) : input;
  const allowed = new Set(['--output-dir', '--provider', '--model']);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || !args[index + 1] || values[args[index]]) {
      throw new SupportProvisionError(
        'Aufruf: node config/provision-support.js --output-dir <Privatverzeichnis> --provider <Anbieter> --model <Modell>',
      );
    }
    values[args[index]] = args[index + 1];
  }
  if (disable && (Object.keys(values).length !== 1 || !values['--output-dir']))
    throw new SupportProvisionError(
      'Aufruf zum Abschalten: node config/provision-support.js --disable --output-dir <Privatverzeichnis>',
    );
  if (!process.env.MONGO_URI) throw new SupportProvisionError('MONGO_URI ist nicht konfiguriert.');
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    if (disable) {
      await disableSupportRuntime(mongoose.connection, values['--output-dir']);
      console.log(
        'Interner Supportzugang abgeschaltet. Ausschliesslich der eigene Schlüssel und das unveränderte technische Konto wurden entfernt; Prüfbelege bleiben erhalten.',
      );
      return;
    }
    await provisionSupportRuntime(mongoose.connection, {
      outputDirectory: values['--output-dir'],
      provider: values['--provider'],
      model: values['--model'],
    });
    console.log(
      'Interner Supportdienst eingerichtet. Zugangsdaten stehen ausschliesslich im geschützten Zielverzeichnis.',
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(
    error instanceof SupportProvisionError
      ? error.message
      : 'Supporteinrichtung fehlgeschlagen. Datenbank und geschützten Einrichtungsstand prüfen.',
  );
  process.exitCode = 1;
});
