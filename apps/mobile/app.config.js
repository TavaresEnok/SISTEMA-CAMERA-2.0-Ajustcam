// Config dinâmica do Expo para builds WHITE-LABEL.
//
// Um único código gera APKs diferentes por cliente. Escolha o cliente com a
// variável de ambiente CLIENT (default = 'default'):
//   CLIENT=flashnet npx expo prebuild ...
//
// Cada cliente vive em clients/<slug>/:
//   config.json  → { appName, slug, packageId, apiUrl, primaryColor }
//   icon.png / splash.png / adaptive-icon.png / logo.png  (opcionais; caem no padrão)
//
// O branding chega ao app em runtime via expo-constants (Constants.expoConfig.extra).
const fs = require('fs');
const path = require('path');

const base = require('./app.base.json').expo;
const client = process.env.CLIENT || 'default';
const clientDir = path.join(__dirname, 'clients', client);

function readClientConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(clientDir, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Caminho de asset do cliente se existir; senão mantém o padrão do app.base.json.
function asset(name, fallback) {
  const p = path.join(clientDir, name);
  return fs.existsSync(p) ? `./clients/${client}/${name}` : fallback;
}

// Fontes do redesign: registradas como FAMÍLIAS NATIVAS com pesos (res/font/*.xml no
// Android). É isso que faz `fontFamily:'Sora'` + `fontWeight:'800'` escolher o arquivo
// certo — sem isso o RN trata cada peso como família separada e o Android finge negrito.
// Só entram no build da variante do redesign (não pesam o app atual).
const REDESIGN_FONTS = [
  {
    fontFamily: 'Sora',
    fontDefinitions: [
      { path: './assets/fonts/Sora-SemiBold.ttf', weight: 600 },
      { path: './assets/fonts/Sora-Bold.ttf', weight: 700 },
      { path: './assets/fonts/Sora-ExtraBold.ttf', weight: 800 },
    ],
  },
  {
    fontFamily: 'InstrumentSans',
    fontDefinitions: [
      { path: './assets/fonts/InstrumentSans-Regular.ttf', weight: 400 },
      { path: './assets/fonts/InstrumentSans-Medium.ttf', weight: 500 },
      { path: './assets/fonts/InstrumentSans-SemiBold.ttf', weight: 600 },
      { path: './assets/fonts/InstrumentSans-Bold.ttf', weight: 700 },
    ],
  },
  {
    fontFamily: 'JetBrainsMono',
    fontDefinitions: [
      { path: './assets/fonts/JetBrainsMono-Medium.ttf', weight: 500 },
      { path: './assets/fonts/JetBrainsMono-SemiBold.ttf', weight: 600 },
    ],
  },
];

const c = readClientConfig();
const allowCleartextTraffic = c.allowCleartext === true || process.env.ALLOW_CLEARTEXT_TRAFFIC === 'true';
const plugins = (base.plugins || []).map((plugin) => {
  if (!Array.isArray(plugin) || plugin[0] !== 'expo-build-properties') return plugin;
  return [
    plugin[0],
    {
      ...(plugin[1] || {}),
      android: {
        ...((plugin[1] && plugin[1].android) || {}),
        usesCleartextTraffic: allowCleartextTraffic,
      },
    },
  ];
});

// A variante do redesign carrega as fontes; o design antigo não (não pesa o APK dele).
const isRedesignBuild = c.redesign === true || process.env.REDESIGN === '1';
// Firebase é DESACOPLADO do redesign: o app OFICIAL com o design novo mantém push.
// O Firebase só entra quando o PACOTE do cliente está registrado no google-services
// (o do cliente, se existir; senão o da raiz). Pacote não registrado quebraria o
// build no plugin do Google ("No matching client found") — típico de apps gerados
// pela Central com pacote novo. `skipFirebase: true` força a remoção manualmente.
// registerForPush() é todo try/catch e devolve null — o app tolera a ausência.
function firebaseRegistered(pkg) {
  try {
    const own = path.join(clientDir, 'google-services.json');
    const file = fs.existsSync(own) ? own : path.join(__dirname, 'google-services.json');
    const g = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (g.client || []).some(
      (cl) => cl && cl.client_info && cl.client_info.android_client_info
        && cl.client_info.android_client_info.package_name === pkg,
    );
  } catch {
    return false;
  }
}
// Push explícito no white-label: a flag `pushEnabled` no config do cliente evita
// a desativação SILENCIOSA do push. Se o cliente EXIGE push (pushEnabled:true) mas
// falta o google-services.json que registra o pacote, o build FALHA alto — em vez
// de entregar um app "com alarmes" que na prática só faz polling em foreground.
const pkgForPush = c.packageId || base.android.package;
const pushRegistered = firebaseRegistered(pkgForPush);
if (c.pushEnabled === true && !pushRegistered) {
  throw new Error(
    `[app.config] Cliente "${c.slug || 'default'}" define pushEnabled:true, mas falta um google-services.json `
    + `registrando o pacote "${pkgForPush}". Registre o pacote no Firebase (clients/<slug>/google-services.json) `
    + `ou defina pushEnabled:false conscientemente.`,
  );
}
const skipFirebase = c.pushEnabled === false || c.skipFirebase === true || !pushRegistered;
if (skipFirebase && c.pushEnabled !== false) {
  // Desativação NÃO-intencional (falta de registro): avisa em vez de silenciar.
  console.warn(
    `[app.config] AVISO: push DESATIVADO para "${c.slug || 'default'}" (pacote "${pkgForPush}" sem google-services.json). `
    + `O app não receberá notificações em background — só polling em foreground. `
    + `Defina pushEnabled:true para transformar isso em erro de build.`,
  );
}
let effectivePlugins = skipFirebase
  ? plugins.filter((p) => (Array.isArray(p) ? p[0] : p) !== 'expo-notifications')
  : plugins;
if (isRedesignBuild) {
  effectivePlugins = [...effectivePlugins, ['expo-font', { android: { fonts: REDESIGN_FONTS } }]];
}

module.exports = () => ({
  expo: {
    ...base,
    name: c.appName || base.name,
    // SLUG fixo (= projeto Expo compartilhado): todos os clientes usam o mesmo
    // projeto Expo (mesmo projectId p/ push/EAS). Só o PACOTE muda por cliente.
    // (Antes trocava o slug por cliente, o que conflita com o projectId do EAS.)
    slug: base.slug,
    icon: asset('icon.png', base.icon),
    plugins: effectivePlugins,
    splash: {
      ...base.splash,
      image: asset('splash.png', base.splash && base.splash.image),
      backgroundColor: c.splashBackgroundColor || (base.splash && base.splash.backgroundColor),
    },
    android: {
      ...base.android,
      package: c.packageId || base.android.package,
      // FCM/push por cliente: cada cliente tem seu próprio pacote → seu próprio
      // google-services.json (registrado no MESMO projeto Firebase). Se o cliente
      // tiver o arquivo, usa o dele; senão cai no padrão (app principal).
      googleServicesFile: skipFirebase ? undefined : asset('google-services.json', base.android.googleServicesFile),
      adaptiveIcon: {
        ...(base.android && base.android.adaptiveIcon),
        foregroundImage: asset('adaptive-icon.png', base.android && base.android.adaptiveIcon && base.android.adaptiveIcon.foregroundImage),
      },
    },
    extra: {
      ...(base.extra || {}),
      client,
      // Liga o REDESIGN (tipografia + paleta novas). Só o cliente "redesign" o ativa —
      // serve para gerar um 2º APK, com o MESMO código e as MESMAS câmeras, mudando só
      // o design, e assim comparar os dois lado a lado de forma justa.
      redesign: c.redesign === true || process.env.REDESIGN === '1',
      appName: c.appName || base.name,
      // Servidor embutido por cliente (cai para a env pública, depois vazio).
      apiUrl: c.apiUrl || process.env.EXPO_PUBLIC_API_URL || '',
      primaryColor: c.primaryColor || null,
    },
  },
});
