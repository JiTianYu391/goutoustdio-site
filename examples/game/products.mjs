// 游戏商品配置。
// 商品由游戏客户端传进来（想卖什么、叫什么、多少钱都由游戏决定），服务端只负责
// 格式校验和兜底；想防作弊的游戏可以把 whitelist 打开，只认这里登记过的商品。
export const PRODUCTS = {
  monthly_pass: { name: "月卡", price: "5.00", credits: 300 },
  starter_pack: { name: "新手礼包", price: "9.90", credits: 600 },
};

// 兜底商品：客户端什么都没传时用它。默认是一袋钻石，游戏可以随时改掉。
export const DEFAULT_PRODUCT = { sku: "100_diamonds", name: "100 钻石", price: "1.00", credits: 100 };

// 是否只接受上面白名单里的 sku。false = 客户端可以自定义商品（示例默认）。
export const WHITELIST_ONLY = false;

export function catalog() {
  return Object.entries(PRODUCTS).map(([sku, p]) => ({ sku, ...p }));
}

// 把客户端传来的商品配置规整成可信的最小结构：
// - sku / name 截断长度，缺了就用兜底
// - price 必须是两位小数的正数，上限 $10,000,000.00；客户端传什么价就按什么价收
// - credits 是发货数量，缺了按服务端白名单推算，再缺就用兜底
export function acceptProduct(input = {}) {
  const sku = String(input.sku || "").trim().slice(0, 40) || DEFAULT_PRODUCT.sku;
  const known = PRODUCTS[sku];
  if (WHITELIST_ONLY && !known) return null;

  const name = String(input.name || known?.name || DEFAULT_PRODUCT.name).trim().slice(0, 200) || DEFAULT_PRODUCT.name;
  const rawPrice = String(input.price ?? known?.price ?? DEFAULT_PRODUCT.price).trim();
  const price = Number(rawPrice);
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(rawPrice) || !Number.isFinite(price) || price <= 0) return null;

  const creditsRaw = Number(input.credits ?? known?.credits ?? DEFAULT_PRODUCT.credits);
  const credits = Number.isFinite(creditsRaw) && creditsRaw > 0 ? Math.min(Math.floor(creditsRaw), 1_000_000) : DEFAULT_PRODUCT.credits;

  return { sku, name, price: rawPrice, credits };
}
