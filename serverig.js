require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// 🔐 Configuration IG
const IG_API_KEY = process.env.IG_API_KEY;
const IG_USERNAME = process.env.IG_USERNAME;
const IG_PASSWORD = process.env.IG_PASSWORD;
const IG_ACCOUNT_TYPE = process.env.IG_ACCOUNT_TYPE || 'LIVE';
const PORT = process.env.PORT || 3000;

const IG_API_URL =
  IG_ACCOUNT_TYPE === 'DEMO'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

let CST = '';
let X_SECURITY_TOKEN = '';

// ✅ EPICs IG à surveiller
const EPICS_EU = [
  'IX.D.DAX.IFMM.IP',
  'IX.D.CAC.IMF.IP',
  'IX.D.STXE.IFM.IP',
  'IX.D.IBEX.IFM.IP',
  'IX.D.MIB.IFM.IP',
  'IX.D.SMI.IFD.IP',
  'IX.D.FTSE.IFE.IP'
];

const EPICS_US = [
  'IX.D.DOW.IFE.IP',
  'IX.D.SPTRD.IEN.IP',
  'IX.D.NASDAQ.IEN.IP',
  'IX.D.RUSSELL.IEN.IP'
];

// 💾 Mémoire locale
const openPrices = {};
const latestData = {};
const lastKnown = {};

// 🔐 Connexion IG
async function loginIG() {
  try {
    const res = await axios.post(
      `${IG_API_URL}/session`,
      { identifier: IG_USERNAME, password: IG_PASSWORD },
      { headers: { 'X-IG-API-KEY': IG_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Version': '2' } }
    );
    CST = res.headers['cst'];
    X_SECURITY_TOKEN = res.headers['x-security-token'];

    // ✅ Affichage sécurisé des tokens dans la console
    console.log(`✅ Connexion IG ${IG_ACCOUNT_TYPE} réussie`);
    console.log(`🔑 CST: ${CST ? CST.slice(0, 6) + '...' + CST.slice(-6) : 'non défini'}`);
    console.log(`🔒 X-SECURITY-TOKEN: ${X_SECURITY_TOKEN ? X_SECURITY_TOKEN.slice(0, 6) + '...' + X_SECURITY_TOKEN.slice(-6) : 'non défini'}`);
  } catch (err) {
    console.error('❌ Erreur de connexion IG :', err.response?.data || err.message);
  }
}

// 🔄 Fetch markets
async function fetchFromMarkets(epic) {
  try {
    const res = await axios.get(`${IG_API_URL}/markets/${epic}`, {
      headers: { 'X-IG-API-KEY': IG_API_KEY, 'CST': CST, 'X-SECURITY-TOKEN': X_SECURITY_TOKEN, 'Accept': 'application/json', 'Version': '3' }
    });
    const snapshot = res.data?.snapshot;
    if (!snapshot) return null;
    const bid = typeof snapshot.bid === 'number' ? snapshot.bid : null;
    const open = snapshot.openPrice?.bid ?? null;
    return (bid !== null || open !== null) ? { bid, open, source: 'markets' } : null;
  } catch {
    return null;
  }
}

// 🔄 Fetch prices/day
async function fetchFromPricesDay(epic) {
  try {
    const res = await axios.get(`${IG_API_URL}/prices/${epic}?resolution=DAY&max=1`, {
      headers: { 'X-IG-API-KEY': IG_API_KEY, 'CST': CST, 'X-SECURITY-TOKEN': X_SECURITY_TOKEN, 'Accept': 'application/json', 'Version': '3' }
    });
    const p = res.data?.prices?.[0];
    if (!p) return null;
    const bid = p.closePrice?.bid ?? p.openPrice?.bid ?? p.closePrice?.ask ?? p.openPrice?.ask ?? null;
    const open = p.openPrice?.bid ?? p.openPrice?.ask ?? null;
    return (bid !== null || open !== null) ? { bid, open, source: 'prices-day' } : null;
  } catch {
    return null;
  }
}

// 🔄 Fonction principale robuste
async function getRobustPriceOpen(epic) {
  if (!CST || !X_SECURITY_TOKEN) return null;

  let res = await fetchFromMarkets(epic);
  if (!res || res.bid === null || res.open === null) {
    const res2 = await fetchFromPricesDay(epic);
    if (res2) {
      res = { bid: res?.bid ?? res2.bid, open: res?.open ?? res2.open, source: (res?.source ?? 'unknown') + ' + prices-day' };
    }
  }

  const bid = res?.bid ?? lastKnown[epic] ?? null;
  const open = res?.open ?? openPrices[epic] ?? null;

  if (bid === null || open === null) return null;

  lastKnown[epic] = bid;
  if (!openPrices[epic]) openPrices[epic] = open;

  const variation = ((bid - openPrices[epic]) / openPrices[epic]) * 100;
  return { bid, open: openPrices[epic], variation, source: res.source };
}

// 🔄 Logs toutes les 2 minutes (séparation US/EU)
async function updatePrices() {
  const allEpics = [...EPICS_US, ...EPICS_EU];

  // Mise à jour latestData
  for (const epic of allEpics) {
    const r = await getRobustPriceOpen(epic);
    if (r) latestData[epic] = { price: r.bid, variation: r.variation };
  }

  // Logs CMD avec séparation US / EU
  console.log('--- US ---');
  EPICS_US.forEach(epic => {
    const r = latestData[epic];
    if (r) console.log(`${epic.padEnd(20)} → Prix: ${r.price}, Ouverture: ${openPrices[epic]}, Var: ${r.variation.toFixed(2)}%`);
  });

  console.log('--- EU ---');
  EPICS_EU.forEach(epic => {
    const r = latestData[epic];
    if (r) console.log(`${epic.padEnd(20)} → Prix: ${r.price}, Ouverture: ${openPrices[epic]}, Var: ${r.variation.toFixed(2)}%`);
  });
}

updatePrices();
setInterval(updatePrices, 2 * 60 * 1000);

// 🌍 Endpoint /quotes → US / EU séparés
app.get('/quotes', (req, res) => {
  const result = { US: {}, EU: {} };

  EPICS_US.forEach(epic => {
    let key = '';
    switch(epic) {
      case 'IX.D.DOW.IFE.IP': key = 'DOW'; break;
      case 'IX.D.SPTRD.IEN.IP': key = 'SP500'; break;
      case 'IX.D.NASDAQ.IEN.IP': key = 'NASDAQ'; break;
      case 'IX.D.RUSSELL.IEN.IP': key = 'RUSSELL'; break;
    }
    if (latestData[epic]) result.US[key] = latestData[epic];
  });

  EPICS_EU.forEach(epic => {
    let key = '';
    switch(epic) {
      case 'IX.D.DAX.IFMM.IP': key = 'DAX'; break;
      case 'IX.D.CAC.IMF.IP': key = 'CAC'; break;
      case 'IX.D.STXE.IFM.IP': key = 'STOXX50'; break; 
      case 'IX.D.IBEX.IFM.IP': key = 'IBEX'; break;
      case 'IX.D.MIB.IFM.IP': key = 'FTSEMIB'; break;   
      case 'IX.D.SMI.IFD.IP': key = 'SMI'; break; 
      case 'IX.D.FTSE.IFE.IP': key = 'FTSE'; break;             
    }
    if (latestData[epic]) result.EU[key] = latestData[epic];
  });

  res.json(result);
});

// 🧪 Test individuel
app.get('/test/:epic', async (req, res) => {
  const epic = req.params.epic;
  const r = await getRobustPriceOpen(epic);
  if (r) {
    res.send(`Prix actuel: ${r.bid}, Ouverture: ${r.open}, Var: ${r.variation.toFixed(2)}%, source: ${r.source}`);
  } else {
    res.send(`Données non disponibles pour ${epic}`);
  }
});

// 🚀 Démarrage serveur
app.get('/', (req, res) => {
  res.send('Serveur Quadrant en ligne ✅');
});

loginIG().then(() => {
  app.listen(PORT, () => console.log(`🟢 IG Proxy ${IG_ACCOUNT_TYPE} lancé sur http://localhost:${PORT}`));
});

