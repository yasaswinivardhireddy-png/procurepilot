// Seed catalog of business supplies. Prices are GST-exclusive, in paise.
export type CatalogProduct = {
  sku: string;
  title: string;
  brand: string;
  category: string;
  unit: string;
  unitPrice: number;
  gstRateBps: number;
  gstInvoice: boolean;
  deliveryDays: number;
  rating: number;
  stock: number;
  seller: string;
  tags: string[];
  description: string;
  tiers: { minQty: number; discountBps: number }[];
};

export const CATEGORIES = {
  office: 'Office Supplies',
  it: 'IT & Electronics',
  cleaning: 'Cleaning & Janitorial',
  pantry: 'Pantry & Breakroom',
  safety: 'Safety & PPE',
  furniture: 'Furniture',
} as const;

const TIERS = {
  office: [
    { minQty: 10, discountBps: 500 },
    { minQty: 50, discountBps: 1200 },
  ],
  it: [
    { minQty: 5, discountBps: 300 },
    { minQty: 20, discountBps: 800 },
  ],
  cleaning: [
    { minQty: 12, discountBps: 600 },
    { minQty: 48, discountBps: 1100 },
  ],
  pantry: [
    { minQty: 10, discountBps: 400 },
    { minQty: 40, discountBps: 900 },
  ],
  safety: [
    { minQty: 10, discountBps: 500 },
    { minQty: 50, discountBps: 1000 },
  ],
  furniture: [
    { minQty: 5, discountBps: 400 },
    { minQty: 15, discountBps: 900 },
  ],
};

const SELLERS = {
  office: 'Rapid Office Supplies',
  it: 'TechServe India',
  cleaning: 'CleanPro Distributors',
  pantry: 'Pantry Express',
  safety: 'SafeWork Traders',
  furniture: 'OfficeNest Furniture',
};

type Group = keyof typeof CATEGORIES;

function product(
  group: Group,
  sku: string,
  title: string,
  brand: string,
  unit: string,
  rupees: number,
  gstPercent: number,
  gstInvoice: boolean,
  deliveryDays: number,
  rating: number,
  stock: number,
  tags: string[],
  description: string,
): CatalogProduct {
  return {
    sku,
    title,
    brand,
    category: CATEGORIES[group],
    unit,
    unitPrice: Math.round(rupees * 100),
    gstRateBps: gstPercent * 100,
    gstInvoice,
    deliveryDays,
    rating,
    stock,
    seller: SELLERS[group],
    tags,
    description,
    tiers: TIERS[group],
  };
}

const PAPER_TAGS = ['paper', 'a4', 'copier', 'printer', 'printing', 'ream', 'sheets'];

export const PRODUCTS: CatalogProduct[] = [
  product('office', 'OFF-A4-JK75', 'JK Copier A4 Paper, 75 GSM, 500 Sheets', 'JK Paper', 'ream', 299, 12, true, 1, 4.5, 5000, PAPER_TAGS, 'Bright white multipurpose paper for laser and inkjet printers and copiers.'),
  product('office', 'OFF-A4-JK70', 'JK Easy Copier A4 Paper, 70 GSM, 500 Sheets', 'JK Paper', 'ream', 265, 12, true, 2, 4.3, 4000, PAPER_TAGS, 'Everyday copier paper for high-volume office printing.'),
  product('office', 'OFF-A4-DA80', 'Double A Premium A4 Paper, 80 GSM, 500 Sheets', 'Double A', 'ream', 420, 12, true, 2, 4.6, 2500, PAPER_TAGS, 'Smooth, jam-free premium paper for presentations and double-sided printing.'),
  product('office', 'OFF-PEN-REY10', 'Reynolds Trimax Gel Pen, Blue, Pack of 10', 'Reynolds', 'pack', 450, 18, true, 1, 4.4, 1200, ['pen', 'pens', 'gel', 'blue', 'writing', 'stationery'], 'Smooth gel ink pens with a comfortable grip.'),
  product('office', 'OFF-PEN-CEL25', 'Cello Butterflow Ball Pen, Blue, Box of 25', 'Cello', 'box', 250, 18, false, 3, 4.2, 900, ['pen', 'pens', 'ballpoint', 'ball', 'blue', 'writing', 'stationery'], 'Light ballpoint pens for daily office use.'),
  product('office', 'OFF-NB-CLS6', 'Classmate Spiral Notebook, A5, 160 Pages, Pack of 6', 'Classmate', 'pack', 420, 12, true, 2, 4.5, 800, ['notebook', 'notebooks', 'spiral', 'a5', 'notepad', 'stationery'], 'Ruled spiral notebooks for meetings and field notes.'),
  product('office', 'OFF-STP-KAN', 'Kangaro HD-45 Stapler with 1000 Pins', 'Kangaro', 'piece', 240, 18, true, 2, 4.4, 600, ['stapler', 'staples', 'pins', 'stationery'], 'All-metal desktop stapler that binds up to 20 sheets.'),
  product('office', 'OFF-FILE-SOLO20', 'Solo Clear Bag File, A4, Pack of 20', 'Solo', 'pack', 560, 18, true, 3, 4.1, 500, ['file', 'files', 'folder', 'folders', 'documents', 'a4'], 'Button-closure document files for A4 papers.'),
  product('office', 'OFF-MKR-CAM10', 'Camlin Whiteboard Marker, Assorted, Pack of 10', 'Camlin', 'pack', 380, 18, true, 2, 4.3, 700, ['marker', 'markers', 'whiteboard', 'meeting'], 'Low-odour, dry-erase markers in four colours.'),
  product('office', 'OFF-STK-3M12', 'Post-it Sticky Notes, 3x3 in, Pack of 12 Pads', 'Post-it', 'pack', 720, 18, true, 1, 4.7, 650, ['sticky', 'notes', 'post-it', 'postit', 'stationery'], 'Repositionable notes, 100 sheets per pad.'),

  product('it', 'IT-MSE-M331', 'Logitech M331 Silent Plus Wireless Mouse', 'Logitech', 'piece', 1395, 18, true, 1, 4.5, 400, ['mouse', 'wireless', 'silent', 'computer', 'peripheral'], 'Quiet clicks and 24-month battery life.'),
  product('it', 'IT-KBM-MK270', 'Logitech MK270 Wireless Keyboard and Mouse Combo', 'Logitech', 'set', 1995, 18, true, 1, 4.4, 350, ['keyboard', 'mouse', 'combo', 'wireless', 'computer'], 'Full-size keyboard and mouse with one USB receiver.'),
  product('it', 'IT-MON-P2425H', 'Dell P2425H 24-inch Full HD IPS Monitor', 'Dell', 'piece', 13499, 18, true, 2, 4.6, 120, ['monitor', 'display', 'screen', '24', 'fhd', 'ips'], 'Height-adjustable monitor with USB-C and a 3-year warranty.'),
  product('it', 'IT-LAP-E14G6', 'Lenovo ThinkPad E14 Gen 6 (Core i5, 16 GB, 512 GB SSD)', 'Lenovo', 'piece', 72990, 18, true, 3, 4.4, 40, ['laptop', 'thinkpad', 'computer', 'i5', 'windows'], 'Business laptop with a 14-inch display and a fingerprint reader.'),
  product('it', 'IT-HDS-EV230', 'Jabra Evolve2 30 USB-C Headset', 'Jabra', 'piece', 6499, 18, true, 2, 4.5, 150, ['headset', 'headphones', 'audio', 'calls', 'usb-c'], 'Certified for Teams and Zoom calls, with noise-cancelling microphones.'),
  product('it', 'IT-HDMI-2M', 'Portronics HDMI 2.1 Cable, 2 m', 'Portronics', 'piece', 349, 18, true, 1, 4.2, 900, ['hdmi', 'cable', 'display', 'video'], 'Braided 8K HDMI cable for monitors and projectors.'),
  product('it', 'IT-SSD-T7-1TB', 'Samsung T7 Portable SSD, 1 TB', 'Samsung', 'piece', 8999, 18, true, 2, 4.7, 200, ['ssd', 'storage', 'portable', 'drive', 'backup'], 'USB 3.2 portable SSD with up to 1,050 MB/s transfers.'),
  product('it', 'IT-UPS-BX600', 'APC Back-UPS BX600C-IN, 600 VA', 'APC', 'piece', 3350, 18, true, 3, 4.3, 140, ['ups', 'power', 'backup', 'battery'], 'Battery backup for desktops and network equipment.'),
  product('it', 'IT-RTR-AX23', 'TP-Link Archer AX23 Wi-Fi 6 Router', 'TP-Link', 'piece', 3999, 18, true, 2, 4.4, 160, ['router', 'wifi', 'wi-fi', 'network', 'internet'], 'Dual-band Wi-Fi 6 router for small offices.'),
  product('it', 'IT-CAM-C270', 'Logitech C270 HD Webcam', 'Logitech', 'piece', 1795, 18, true, 2, 4.3, 260, ['webcam', 'camera', 'video', 'calls'], '720p webcam with a built-in noise-reducing microphone.'),

  product('cleaning', 'CLN-LIZ-5L', 'Lizol Disinfectant Floor Cleaner, Citrus, 5 L', 'Lizol', 'can', 899, 18, true, 2, 4.5, 600, ['floor', 'cleaner', 'disinfectant', 'cleaning'], 'Kills 99.9% of germs; suitable for all floor types.'),
  product('cleaning', 'CLN-HAR-1LX3', 'Harpic Power Plus Toilet Cleaner, 1 L, Pack of 3', 'Harpic', 'pack', 540, 18, true, 2, 4.6, 700, ['toilet', 'cleaner', 'bathroom', 'washroom', 'cleaning'], 'Thick liquid cleaner for washrooms.'),
  product('cleaning', 'CLN-DET-HW15', 'Dettol Liquid Handwash Refill, 1.5 L', 'Dettol', 'bottle', 329, 18, true, 1, 4.6, 900, ['handwash', 'soap', 'hygiene', 'hand', 'wash'], 'Germ-protection handwash refill for washroom dispensers.'),
  product('cleaning', 'CLN-BAG-L180', 'Garbage Bags, Large, 30 Bags x 6 Rolls', 'Ezee', 'pack', 480, 18, false, 3, 4.1, 500, ['garbage', 'bags', 'trash', 'bin', 'waste'], 'Leak-proof black garbage bags for large bins.'),
  product('cleaning', 'CLN-TIS-ORI10', 'Origami Soft Facial Tissues, 2-Ply, Pack of 10', 'Origami', 'pack', 650, 18, true, 2, 4.4, 650, ['tissue', 'tissues', 'facial', 'napkin'], 'Soft 2-ply tissues for meeting rooms and reception.'),

  product('pantry', 'PAN-TEA-TAJ1KG', 'Taj Mahal Tea, 1 kg', 'Brooke Bond', 'pack', 620, 5, true, 2, 4.6, 450, ['tea', 'chai', 'beverage', 'pantry'], 'Rich Assam tea for the office pantry.'),
  product('pantry', 'PAN-COF-NES500', 'Nescafe Classic Instant Coffee, 500 g', 'Nescafe', 'jar', 1190, 18, true, 2, 4.5, 300, ['coffee', 'instant', 'beverage', 'pantry'], 'Instant coffee for vending machines and pantries.'),
  product('pantry', 'PAN-SUG-500', 'Sugar Sticks, 5 g, Pack of 500', 'Pantry Basics', 'pack', 650, 5, true, 3, 4.0, 400, ['sugar', 'sachets', 'sticks', 'pantry'], 'Hygienic single-serve sugar sticks.'),
  product('pantry', 'PAN-CUP-150X1000', 'Paper Cups, 150 ml, Pack of 1000', 'EcoServe', 'pack', 899, 18, true, 2, 4.2, 350, ['cups', 'disposable', 'pantry', 'tea', 'coffee'], 'Food-grade cups for hot and cold drinks.'),
  product('pantry', 'PAN-WAT-BIS24', 'Bisleri Packaged Drinking Water, 500 ml, Pack of 24', 'Bisleri', 'pack', 240, 18, true, 1, 4.5, 800, ['water', 'bottles', 'drinking', 'pantry'], 'Packaged drinking water for meetings and events.'),

  product('safety', 'SAF-GLV-NIT100', 'Nitrile Examination Gloves, Medium, Box of 100', 'SafeHands', 'box', 699, 12, true, 2, 4.3, 500, ['gloves', 'nitrile', 'ppe', 'safety', 'hygiene'], 'Powder-free, latex-free disposable gloves.'),
  product('safety', 'SAF-MSK-N95X20', 'N95 Respirator Masks, Pack of 20', 'Venus', 'pack', 1200, 5, true, 2, 4.4, 400, ['mask', 'masks', 'n95', 'respirator', 'ppe', 'safety'], 'NIOSH-style N95 masks for dusty work areas.'),
  product('safety', 'SAF-HLM-KAR', 'Karam Safety Helmet with Ratchet, White', 'Karam', 'piece', 449, 18, false, 4, 4.2, 300, ['helmet', 'safety', 'head', 'ppe', 'construction'], 'ISI-marked industrial helmet with an adjustable ratchet.'),
  product('safety', 'SAF-FAK-WRK', 'St Johns Workplace First Aid Kit, 100+ Items', 'St Johns', 'kit', 1299, 12, true, 2, 4.5, 250, ['first', 'aid', 'kit', 'medical', 'emergency', 'safety'], 'Wall-mountable first aid kit for offices and warehouses.'),

  product('furniture', 'FUR-CHR-GSSEOUL', 'Green Soul Seoul Ergonomic Office Chair, Mid-Back', 'Green Soul', 'piece', 8990, 18, true, 4, 4.3, 80, ['chair', 'office', 'ergonomic', 'seating', 'furniture'], 'Mesh-back chair with lumbar support and adjustable armrests.'),
  product('furniture', 'FUR-DSK-FL120', 'Featherlite Height-Adjustable Desk, 120 x 60 cm', 'Featherlite', 'piece', 28500, 18, true, 5, 4.4, 25, ['desk', 'table', 'standing', 'height', 'adjustable', 'furniture'], 'Electric sit-stand desk with memory presets.'),
];
