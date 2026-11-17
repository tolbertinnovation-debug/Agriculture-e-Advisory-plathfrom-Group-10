// Demo data for the AgriConnect Liberia prototype.
// All prices, counts and forecasts below are SAMPLE values for demonstration only.
// In production they come from the AgriConnect API (MOA, LISGIS, market reporters, weather feeds).

const COUNTIES = [
  "Bomi", "Bong", "Gbarpolu", "Grand Bassa", "Grand Cape Mount", "Grand Gedeh",
  "Grand Kru", "Lofa", "Margibi", "Maryland", "Montserrado", "Nimba",
  "River Cess", "River Gee", "Sinoe"
];

const FARMER = {
  name: "Kollie",
  county: "Bong",
  district: "Salala",
  crops: ["Rice (upland)", "Cassava", "Pepper"],
  language: "Liberian English",
  phone: "077 xxx xxxx"
};

const WEATHER = [
  { day: "Today", icon: "🌧️", hi: 29, lo: 23, rain: 80, note: "Heavy rain after 2pm" },
  { day: "Wed", icon: "⛈️", hi: 28, lo: 23, rain: 90, note: "Thunderstorm" },
  { day: "Thu", icon: "🌦️", hi: 30, lo: 24, rain: 55, note: "Showers" },
  { day: "Fri", icon: "⛅", hi: 31, lo: 24, rain: 30, note: "Partly cloudy" },
  { day: "Sat", icon: "☀️", hi: 32, lo: 24, rain: 10, note: "Good day to spray" }
];

const TASKS = [
  { crop: "Rice", text: "Weed your upland rice field (week 3 after planting)", done: false },
  { crop: "Cassava", text: "Check leaves for yellow mosaic patterns", done: false },
  { crop: "Pepper", text: "Don’t spray today — rain will wash it off", done: true }
];

const CROP_GUIDES = {
  "Rice (upland)": [
    { stage: "Land prep", when: "Feb – Mar", tip: "Brush and clear early. Avoid burning near the forest edge." },
    { stage: "Planting", when: "Apr – May", tip: "Plant with the first steady rains. Use certified seed (e.g. NERICA)." },
    { stage: "Weeding", when: "Weeks 3 & 6", tip: "Two clean weedings can make a big difference to the harvest." },
    { stage: "Bird scaring", when: "Grain filling", tip: "Guard the field morning and evening when grains are milky." },
    { stage: "Harvest", when: "Aug – Oct", tip: "Harvest when 80–85% of grains are golden. Dry on tarpaulin, not bare ground." }
  ],
  "Cassava": [
    { stage: "Cuttings", when: "Start of rains", tip: "Use healthy stems, 25 cm long, from plants with no mosaic signs." },
    { stage: "Planting", when: "Apr – Jun", tip: "Plant at an angle on mounds or ridges, 1 m apart." },
    { stage: "Weeding", when: "Months 1–3", tip: "Keep the field clean until the canopy closes." },
    { stage: "Harvest", when: "Month 9–18", tip: "Harvest as needed. Process within 48 hours to avoid spoilage." }
  ],
  "Cocoa": [
    { stage: "Pruning", when: "Dry season", tip: "Open the canopy so air moves; it reduces black pod." },
    { stage: "Sanitation", when: "Every 2 weeks", tip: "Remove and bury black/rotten pods." },
    { stage: "Harvest", when: "Oct – Mar", tip: "Pick only ripe pods. Ferment 5–6 days, then sun-dry." }
  ]
};

const PESTS = [
  {
    id: "faw", name: "Fall armyworm", crop: "Maize / Rice",
    symptoms: ["holes", "frass", "caterpillar"],
    signs: "Ragged holes in leaves, sawdust-like droppings in the funnel, green-brown caterpillars with a Y mark on the head.",
    actions: [
      "Check 20 plants in a W pattern across the field.",
      "Hand-pick and crush caterpillars early in the morning.",
      "Put a pinch of wood ash or sand mixed with a little pepper in the funnel.",
      "If more than 1 in 5 plants is attacked, ask your extension officer about approved spray."
    ]
  },
  {
    id: "cmd", name: "Cassava mosaic disease", crop: "Cassava",
    symptoms: ["yellow", "twisted"],
    signs: "Yellow-green patches on leaves, leaves twisted and smaller, plant stunted.",
    actions: [
      "Pull out and burn badly infected plants.",
      "Never use cuttings from sick plants.",
      "Ask for tolerant varieties at your nearest agro-dealer or CARI.",
      "Control whiteflies, which spread the disease."
    ]
  },
  {
    id: "blackpod", name: "Cocoa black pod", crop: "Cocoa",
    symptoms: ["brown", "rot"],
    signs: "Brown-black spots that spread over the whole pod, white powder on the pod in wet weather.",
    actions: [
      "Remove all sick pods every 1–2 weeks and bury them.",
      "Prune to let light and air into the farm.",
      "Harvest ripe pods often.",
      "Ask an officer about copper-based fungicide in the rainy season."
    ]
  },
  {
    id: "blast", name: "Rice blast", crop: "Rice",
    symptoms: ["spots", "brown", "neck"],
    signs: "Diamond-shaped spots with grey centres on leaves; the neck of the panicle turns brown and breaks.",
    actions: [
      "Don’t over-apply nitrogen (urea).",
      "Use resistant varieties next season.",
      "Burn infected straw after harvest.",
      "Report to your extension officer — blast spreads fast in wet weather."
    ]
  }
];

const MARKETS = ["Red Light (Monrovia)", "Gbarnga", "Ganta", "Voinjama", "Buchanan"];

// Prices in LRD — SAMPLE DATA
const PRICES = [
  { item: "Local rice (cup)", unit: "cup", prices: [55, 45, 45, 40, 50], change: +5 },
  { item: "Imported rice (25 kg)", unit: "bag", prices: [3900, 4100, 4150, 4300, 4000], change: +2 },
  { item: "Cassava (fresh, rubber bucket)", unit: "bucket", prices: [650, 450, 500, 400, 550], change: -3 },
  { item: "Gari / fufu (cup)", unit: "cup", prices: [40, 30, 30, 25, 35], change: 0 },
  { item: "Hot pepper (pile)", unit: "pile", prices: [100, 75, 75, 60, 90], change: +12 },
  { item: "Palm oil (gallon)", unit: "gallon", prices: [1100, 900, 950, 850, 1000], change: -4 },
  { item: "Cocoa (dried, kg)", unit: "kg", prices: [0, 0, 1250, 1300, 0], change: +6 },
  { item: "Plantain (bunch)", unit: "bunch", prices: [700, 500, 550, 450, 600], change: +1 }
];

const CHAT = [
  { from: "farmer", text: "My pepper leaves dey curling and turning yellow. What I can do?", time: "08:12" },
  { from: "officer", text: "Good morning Kollie. Please send a photo of the leaves, top and underneath. It may be whitefly or aphids.", time: "08:40", who: "Ext. Officer Mulbah — Bong" },
  { from: "farmer", text: "📷 Photo sent", time: "08:44" },
  { from: "officer", text: "I see small white insects underneath — whitefly. Spray neem leaf water (pound 1 kg leaves in 5 L water, leave overnight, strain) every 5 days. I will visit Salala on Thursday.", time: "09:05", who: "Ext. Officer Mulbah — Bong" }
];

const DEALERS = [
  { name: "Gbarnga Agro Inputs", dist: "4 km", items: "Seeds, cutlass, sprayers" },
  { name: "Salala Farmers Co-op Store", dist: "1 km", items: "Rice seed, tarpaulins" },
  { name: "CARI Seed Unit", dist: "12 km", items: "Improved cassava & rice varieties" }
];

// Officer dashboard — SAMPLE DATA
const DASH = {
  kpis: [
    { label: "Registered farmers", value: "12,480", delta: "+640 this month" },
    { label: "Advisories delivered", value: "48,915", delta: "SMS · USSD · Voice · App" },
    { label: "Open farmer questions", value: "37", delta: "Avg reply 5.2 h" },
    { label: "Pest reports (7 days)", value: "21", delta: "3 counties flagged" }
  ],
  byCounty: [
    ["Bong", 2380], ["Nimba", 2105], ["Lofa", 1890], ["Montserrado", 1210], ["Margibi", 980],
    ["Grand Bassa", 860], ["Bomi", 610], ["Grand Gedeh", 540], ["Maryland", 470], ["Sinoe", 390],
    ["Grand Cape Mount", 330], ["River Cess", 260], ["Gbarpolu", 210], ["Grand Kru", 140], ["River Gee", 105]
  ],
  channels: [["SMS", 41], ["USSD", 27], ["Voice (IVR)", 18], ["Smartphone app", 14]],
  questions: [
    { farmer: "Kollie M.", county: "Bong", crop: "Pepper", q: "Leaves curling and yellow", age: "2h", status: "Answered" },
    { farmer: "Fatu K.", county: "Lofa", crop: "Rice", q: "Brown spots on rice leaves, spreading", age: "3h", status: "Urgent" },
    { farmer: "Musu T.", county: "Nimba", crop: "Cocoa", q: "Pods turning black", age: "5h", status: "Open" },
    { farmer: "Joseph D.", county: "Margibi", crop: "Cassava", q: "When to harvest for gari?", age: "6h", status: "Open" },
    { farmer: "Comfort S.", county: "Grand Bassa", crop: "Vegetables", q: "Where to buy improved seed?", age: "1d", status: "Open" }
  ],
  outbreaks: [
    { pest: "Fall armyworm", county: "Nimba", reports: 9, level: "High" },
    { pest: "Rice blast", county: "Lofa", reports: 6, level: "Medium" },
    { pest: "Cocoa black pod", county: "Nimba", reports: 4, level: "Medium" },
    { pest: "Cassava mosaic", county: "Bong", reports: 2, level: "Low" }
  ]
};
