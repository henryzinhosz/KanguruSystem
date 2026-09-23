import { 
  Product, 
  StoreUnit, 
  StockInventory, 
  Sale, 
  Expense, 
  TradeIn, 
  WorkOrder, 
  StoreConfig,
  Supplier,
  CardCondition
} from '../types';

export const STORE_UNITS: StoreUnit[] = [
  { id: 'central', name: 'Estoque Central (Hub Logístico)', isStore: false },
  { id: 'loja_1', name: 'Loja 1 - Park Shopping CG', isStore: true },
  { id: 'loja_2', name: 'Loja 2 - Barra da Tijuca', isStore: true },
  { id: 'loja_3', name: 'Loja 3 - Park Shopping Jacarepagua', isStore: true }
];

export const PRODUCTS_CATALOG: Product[] = [
  // Consoles (Serialized)
  {
    id: 'p1',
    sku: 'CON-PS5-001',
    name: 'PlayStation 5 Slim 1TB',
    category: 'Videogames',
    brand: 'Sony',
    costPrice: 3200,
    sellPrice: 4200,
    ncm: '9504.50.00',
    warrantyMonths: 12,
    isSerialized: true,
    isUsed: false,
    variations: [
      { id: 'v1', name: 'Edição Mídia Física', skuSuffix: 'MID' },
      { id: 'v2', name: 'Edição Digital', skuSuffix: 'DIG' }
    ]
  },
  {
    id: 'p2',
    sku: 'CON-NSW-002',
    name: 'Nintendo Switch OLED 64GB',
    category: 'Videogames',
    brand: 'Nintendo',
    costPrice: 1600,
    sellPrice: 2200,
    ncm: '9504.50.00',
    warrantyMonths: 12,
    isSerialized: true,
    isUsed: false,
    variations: [
      { id: 'v3', name: 'Joy-Con Azul/Vermelho', skuSuffix: 'BLURED' },
      { id: 'v4', name: 'Joy-Con Branco', skuSuffix: 'WHITE' }
    ]
  },
  // Used console
  {
    id: 'p3',
    sku: 'CON-PS4-USED',
    name: 'PlayStation 4 Pro 1TB (Usado)',
    category: 'Videogames',
    brand: 'Sony',
    costPrice: 1000,
    sellPrice: 1500,
    ncm: '9504.50.00',
    warrantyMonths: 3, // shorter warranty for used
    isSerialized: true,
    isUsed: true
  },
  // PC Parts (Serialized & Non-Serialized)
  {
    id: 'p4',
    sku: 'GPU-RTX4070-001',
    name: 'Placa de Vídeo RTX 4070 ASUS Dual',
    category: 'Peças',
    brand: 'ASUS',
    costPrice: 3800,
    sellPrice: 4800,
    ncm: '8473.30.43',
    warrantyMonths: 24,
    isSerialized: true,
    isUsed: false
  },
  {
    id: 'p5',
    sku: 'MBO-ASUSB760-002',
    name: 'Placa-Mãe ASUS Prime B760-PLUS',
    category: 'Peças',
    brand: 'ASUS',
    costPrice: 750,
    sellPrice: 1100,
    ncm: '8473.30.41',
    warrantyMonths: 12,
    isSerialized: true,
    isUsed: false
  },
  {
    id: 'p6',
    sku: 'RAM-CORSAIR-003',
    name: 'Memória Corsair Vengeance 32GB (2x16GB) DDR5 5600Mhz',
    category: 'Peças',
    brand: 'Corsair',
    costPrice: 500,
    sellPrice: 750,
    ncm: '8473.30.42',
    warrantyMonths: 36, // lifetime-ish warranty
    isSerialized: false,
    isUsed: false
  },
  // Pokemon Cards
  {
    id: 'p7',
    sku: 'CRD-CHARIZARD-BSET',
    name: 'Carta Pokémon Charizard Holo Base Set #4',
    category: 'Cards',
    brand: 'Nintendo/Pokémon',
    costPrice: 800,
    sellPrice: 1800,
    ncm: '9504.40.00',
    warrantyMonths: 0,
    isSerialized: false,
    isUsed: true // Cards count as used / graded
  },
  {
    id: 'p8',
    sku: 'CRD-PST-151BOX',
    name: 'Box Pokémon Escarlate e Violeta 151 (Lacrado)',
    category: 'Cards',
    brand: 'Copag',
    costPrice: 280,
    sellPrice: 420,
    ncm: '9504.40.00',
    warrantyMonths: 0,
    isSerialized: false,
    isUsed: false
  },
  // Kits
  {
    id: 'p9',
    sku: 'KIT-GAMER-STARTER',
    name: 'Kit Gamer Starter (Console PS5 + Controle DualSense extra + Jogo Spider-Man)',
    category: 'Videogames',
    brand: 'Sony',
    costPrice: 3800,
    sellPrice: 4900,
    ncm: '9504.50.00',
    warrantyMonths: 12,
    isSerialized: false,
    isUsed: false,
    isKit: true,
    kitItems: [
      { productId: 'p1', variationId: 'v1', quantity: 1 } // PS5 physical
      // extra accessories are drawn as bundle
    ]
  }
];

export const STOCK_INVENTORY_INITIAL: StockInventory[] = [
  {
    productId: 'p1',
    quantities: {
      central: { unitId: 'central', qty: 15, serials: ['PS5-CEN-01', 'PS5-CEN-02', 'PS5-CEN-03', 'PS5-CEN-04', 'PS5-CEN-05', 'PS5-CEN-06', 'PS5-CEN-07', 'PS5-CEN-08', 'PS5-CEN-09', 'PS5-CEN-10', 'PS5-CEN-11', 'PS5-CEN-12', 'PS5-CEN-13', 'PS5-CEN-14', 'PS5-CEN-15'] },
      loja_1: { unitId: 'loja_1', qty: 4, serials: ['PS5-L1-01', 'PS5-L1-02', 'PS5-L1-03', 'PS5-L1-04'] },
      loja_2: { unitId: 'loja_2', qty: 2, serials: ['PS5-L2-01', 'PS5-L2-02'] },
      loja_3: { unitId: 'loja_3', qty: 1, serials: ['PS5-L3-01'] } // Baixo estoque
    }
  },
  {
    productId: 'p2',
    quantities: {
      central: { unitId: 'central', qty: 12, serials: ['NSW-CEN-01', 'NSW-CEN-02', 'NSW-CEN-03', 'NSW-CEN-04', 'NSW-CEN-05', 'NSW-CEN-06', 'NSW-CEN-07', 'NSW-CEN-08', 'NSW-CEN-09', 'NSW-CEN-10', 'NSW-CEN-11', 'NSW-CEN-12'] },
      loja_1: { unitId: 'loja_1', qty: 3, serials: ['NSW-L1-01', 'NSW-L1-02', 'NSW-L1-03'] },
      loja_2: { unitId: 'loja_2', qty: 3, serials: ['NSW-L2-01', 'NSW-L2-02', 'NSW-L2-03'] },
      loja_3: { unitId: 'loja_3', qty: 5, serials: ['NSW-L3-01', 'NSW-L3-02', 'NSW-L3-03', 'NSW-L3-04', 'NSW-L3-05'] }
    }
  },
  {
    productId: 'p3',
    quantities: {
      central: { unitId: 'central', qty: 2, serials: ['PS4-CEN-01', 'PS4-CEN-02'] },
      loja_1: { unitId: 'loja_1', qty: 1, serials: ['PS4-L1-01'] },
      loja_2: { unitId: 'loja_2', qty: 1, serials: ['PS4-L2-01'] },
      loja_3: { unitId: 'loja_3', qty: 0, serials: [] }
    }
  },
  {
    productId: 'p4',
    quantities: {
      central: { unitId: 'central', qty: 8, serials: ['RTX-CEN-01', 'RTX-CEN-02', 'RTX-CEN-03', 'RTX-CEN-04', 'RTX-CEN-05', 'RTX-CEN-06', 'RTX-CEN-07', 'RTX-CEN-08'] },
      loja_1: { unitId: 'loja_1', qty: 1, serials: ['RTX-L1-01'] }, // Baixo estoque
      loja_2: { unitId: 'loja_2', qty: 2, serials: ['RTX-L2-01', 'RTX-L2-02'] },
      loja_3: { unitId: 'loja_3', qty: 0, serials: [] } // Esgotado
    }
  },
  {
    productId: 'p5',
    quantities: {
      central: { unitId: 'central', qty: 20, serials: ['B760-CEN-01', 'B760-CEN-02', 'B760-CEN-03', 'B760-CEN-04', 'B760-CEN-05', 'B760-CEN-06', 'B760-CEN-07'] },
      loja_1: { unitId: 'loja_1', qty: 5, serials: ['B760-L1-01', 'B760-L1-02'] },
      loja_2: { unitId: 'loja_2', qty: 4, serials: ['B760-L2-01', 'B760-L2-02'] },
      loja_3: { unitId: 'loja_3', qty: 2, serials: ['B760-L3-01', 'B760-L3-02'] }
    }
  },
  {
    productId: 'p6',
    quantities: {
      central: { unitId: 'central', qty: 50 },
      loja_1: { unitId: 'loja_1', qty: 15 },
      loja_2: { unitId: 'loja_2', qty: 12 },
      loja_3: { unitId: 'loja_3', qty: 8 }
    }
  },
  {
    productId: 'p7',
    quantities: {
      central: { 
        unitId: 'central', 
        qty: 3, 
        cardConditions: { PSA_10: 1, NEAR_MINT: 1, LIGHTLY_PLAYED: 1 } 
      },
      loja_1: { 
        unitId: 'loja_1', 
        qty: 1, 
        cardConditions: { NEAR_MINT: 1 } 
      },
      loja_2: { 
        unitId: 'loja_2', 
        qty: 2, 
        cardConditions: { LIGHTLY_PLAYED: 1, DAMAGED: 1 } 
      },
      loja_3: { 
        unitId: 'loja_3', 
        qty: 1, 
        cardConditions: { PSA_10: 1 } 
      }
    }
  },
  {
    productId: 'p8',
    quantities: {
      central: { unitId: 'central', qty: 100 },
      loja_1: { unitId: 'loja_1', qty: 30 },
      loja_2: { unitId: 'loja_2', qty: 25 },
      loja_3: { unitId: 'loja_3', qty: 15 }
    }
  }
];

export const STORE_CONFIGS_INITIAL: StoreConfig[] = [
  {
    unitId: 'loja_1',
    fixedCost: 18000,
    paymentFees: { DINHEIRO: 0.0, PIX: 0.005, CREDITO: 0.035, DEBITO: 0.015 }
  },
  {
    unitId: 'loja_2',
    fixedCost: 14000,
    paymentFees: { DINHEIRO: 0.0, PIX: 0.005, CREDITO: 0.035, DEBITO: 0.015 }
  },
  {
    unitId: 'loja_3',
    fixedCost: 9500,
    paymentFees: { DINHEIRO: 0.0, PIX: 0.005, CREDITO: 0.035, DEBITO: 0.015 }
  }
];

// Past 30 days of Sales to make dynamic analytics super realistic!
export const SALES_INITIAL: Sale[] = [
  {
    id: 's1',
    invoiceNumber: 'VD-1001',
    unitId: 'loja_1',
    grossAmount: 4200,
    feeAmount: 147, // 3.5% credit card fee
    netAmount: 4053,
    paymentMethod: 'CREDITO',
    operatorId: 'op1',
    operatorName: 'Rodrigo Silva',
    clientCpf: '123.456.789-00',
    clientName: 'Arthur Dent',
    timestamp: '2026-07-10T14:30:00Z',
    status: 'CONCLUIDA',
    requiresApproval: false,
    items: [{ productId: 'p1', variationId: 'v1', quantity: 1, unitPrice: 4200, serials: ['PS5-L1-05'] }]
  },
  {
    id: 's2',
    invoiceNumber: 'VD-1002',
    unitId: 'loja_2',
    grossAmount: 2200,
    feeAmount: 11, // 0.5% Pix
    netAmount: 2189,
    paymentMethod: 'PIX',
    operatorId: 'op2',
    operatorName: 'Marina Costa',
    clientCpf: '987.654.321-99',
    clientName: 'Carla Souza',
    timestamp: '2026-07-12T10:15:00Z',
    status: 'CONCLUIDA',
    requiresApproval: false,
    items: [{ productId: 'p2', variationId: 'v3', quantity: 1, unitPrice: 2200, serials: ['NSW-L2-06'] }]
  },
  {
    id: 's3',
    invoiceNumber: 'VD-1003',
    unitId: 'loja_1',
    grossAmount: 4800,
    feeAmount: 0, // cash
    netAmount: 4800,
    paymentMethod: 'DINHEIRO',
    operatorId: 'op1',
    operatorName: 'Rodrigo Silva',
    clientCpf: '111.222.333-44',
    clientName: 'João da Silva',
    timestamp: '2026-07-13T16:45:00Z',
    status: 'CONCLUIDA',
    requiresApproval: false,
    items: [{ productId: 'p4', quantity: 1, unitPrice: 4800, serials: ['RTX-L1-02'] }]
  },
  {
    id: 's4',
    invoiceNumber: 'VD-1004',
    unitId: 'loja_3',
    grossAmount: 750,
    feeAmount: 11.25, // 1.5% Debit
    netAmount: 738.75,
    paymentMethod: 'DEBITO',
    operatorId: 'op3',
    operatorName: 'Lucas Lima',
    clientCpf: '222.333.444-55',
    clientName: 'Beatriz Santos',
    timestamp: '2026-07-14T11:00:00Z',
    status: 'CONCLUIDA',
    requiresApproval: false,
    items: [{ productId: 'p6', quantity: 1, unitPrice: 750 }]
  },
  {
    id: 's5',
    invoiceNumber: 'VD-1005',
    unitId: 'loja_1',
    grossAmount: 1260, // 3 booster boxes
    feeAmount: 6.3, // Pix
    netAmount: 1253.7,
    paymentMethod: 'PIX',
    operatorId: 'op1',
    operatorName: 'Rodrigo Silva',
    clientCpf: '333.444.555-66',
    clientName: 'Guilherme Reis',
    timestamp: '2026-07-15T09:30:00Z',
    status: 'CONCLUIDA',
    requiresApproval: false,
    items: [{ productId: 'p8', quantity: 3, unitPrice: 420 }]
  },
  {
    id: 's6',
    invoiceNumber: 'VD-1006',
    unitId: 'loja_2',
    grossAmount: 1800, // Charizard Base Set Near Mint
    feeAmount: 63, // credit card
    netAmount: 1737,
    paymentMethod: 'CREDITO',
    operatorId: 'op2',
    operatorName: 'Marina Costa',
    clientCpf: '444.555.666-77',
    clientName: 'Pedro Antunes',
    timestamp: '2026-07-16T15:20:00Z',
    status: 'CONCLUIDA',
    requiresApproval: false,
    items: [{ productId: 'p7', cardCondition: 'NEAR_MINT', quantity: 1, unitPrice: 1800 }]
  },
  // High value cancellation needing admin approval demo
  {
    id: 's7',
    invoiceNumber: 'VD-1007',
    unitId: 'loja_2',
    grossAmount: 4200,
    feeAmount: 147,
    netAmount: 4053,
    paymentMethod: 'CREDITO',
    operatorId: 'op2',
    operatorName: 'Marina Costa',
    clientCpf: '444.555.666-77',
    clientName: 'Pedro Antunes',
    timestamp: '2026-07-17T11:00:00Z',
    status: 'PENDENTE_APROVACAO',
    requiresApproval: true,
    items: [{ productId: 'p1', variationId: 'v1', quantity: 1, unitPrice: 4200, serials: ['PS5-L2-03'] }]
  }
];

export const EXPENSES_INITIAL: Expense[] = [
  {
    id: 'e1',
    unitId: 'loja_1',
    description: 'Conta de Energia Elétrica - Julho',
    category: 'Água/Luz',
    amount: 1250,
    operatorId: 'op1',
    operatorName: 'Rodrigo Silva',
    timestamp: '2026-07-05T14:00:00Z'
  },
  {
    id: 'e2',
    unitId: 'loja_2',
    description: 'Internet Fibra e Telefonia',
    category: 'Água/Luz',
    amount: 350,
    operatorId: 'op2',
    operatorName: 'Marina Costa',
    timestamp: '2026-07-06T10:00:00Z'
  },
  {
    id: 'e3',
    unitId: 'loja_3',
    description: 'Compra de material de limpeza urgente',
    category: 'Compras Urgentes',
    amount: 120,
    operatorId: 'op3',
    operatorName: 'Lucas Lima',
    timestamp: '2026-07-08T15:30:00Z'
  },
  {
    id: 'e4',
    unitId: 'loja_1',
    description: 'Manutenção do Ar Condicionado',
    category: 'Manutenção',
    amount: 800,
    operatorId: 'op1',
    operatorName: 'Rodrigo Silva',
    timestamp: '2026-07-12T11:00:00Z'
  }
];

export const TRADE_INS_INITIAL: TradeIn[] = [
  {
    id: 't1',
    sellerName: 'Gabriel Medeiros',
    sellerCpf: '555.666.777-88',
    itemDescription: 'Nintendo Switch Lite Amarelo (Usado)',
    category: 'Videogames',
    condition: 'Excelente',
    valuationAmount: 600,
    operatorId: 'op1',
    operatorName: 'Rodrigo Silva',
    unitId: 'loja_1',
    timestamp: '2026-07-11T13:00:00Z',
    status: 'APROVADO'
  },
  {
    id: 't2',
    sellerName: 'Juliana Vieira',
    sellerCpf: '666.777.888-99',
    itemDescription: 'Jogo PS5 - Demon Souls (Usado)',
    category: 'Jogos',
    condition: 'Near Mint',
    valuationAmount: 100,
    operatorId: 'op2',
    operatorName: 'Marina Costa',
    unitId: 'loja_2',
    timestamp: '2026-07-15T16:20:00Z',
    status: 'AVALIADO'
  }
];

export const WORK_ORDERS_INITIAL: WorkOrder[] = [
  {
    id: 'wo1',
    osNumber: 'OS-2026-001',
    clientName: 'Felipe Alencar',
    clientPhone: '(11) 98888-7777',
    equipment: 'Computador Gamer Customizado',
    problemDescription: 'Montagem de computador do zero com peças compradas na loja mais cable management.',
    status: 'AGUARDANDO_PECA',
    partsCost: 350, // thermal paste, sleeves, fans
    laborCost: 250,
    totalCost: 600,
    unitId: 'loja_1',
    operatorId: 'op1',
    operatorName: 'Rodrigo Silva',
    timestamp: '2026-07-14T09:00:00Z'
  },
  {
    id: 'wo2',
    osNumber: 'OS-2026-002',
    clientName: 'Mariana Peixoto',
    clientPhone: '(11) 97777-6666',
    equipment: 'Notebook Dell G15',
    problemDescription: 'Limpeza interna completa, troca de pasta térmica e upgrade de SSD para 1TB Corsair.',
    status: 'PRONTO',
    partsCost: 450, // SSD 1TB cost
    laborCost: 150,
    totalCost: 600,
    linkedSerial: 'SSD-COR-99',
    unitId: 'loja_2',
    operatorId: 'op2',
    operatorName: 'Marina Costa',
    timestamp: '2026-07-16T10:30:00Z'
  }
];

export const SUPPLIERS_INITIAL: Supplier[] = [
  { id: 's1', name: 'Copag Distribuidora de Cards', cnpj: '00.123.456/0001-99', contact: 'comercial@copag.com.br', category: 'Cards Pokémon', historyCount: 14 },
  { id: 's2', name: 'ASUS Brasil Importação', cnpj: '11.222.333/0001-88', contact: 'vendas@asus.com.br', category: 'Peças e Motherboards', historyCount: 8 },
  { id: 's3', name: 'Sony Interactive Brasil', cnpj: '22.333.444/0001-77', contact: 'games@sony.com.br', category: 'Videogames e Acessórios', historyCount: 22 },
  { id: 's4', name: 'SND Informática Distribuidora', cnpj: '33.444.555/0001-66', contact: 'atendimento@snd.com.br', category: 'Informática e Hardware', historyCount: 31 }
];
