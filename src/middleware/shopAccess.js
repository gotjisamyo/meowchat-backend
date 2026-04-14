const { getDb } = require('../db');

async function getOwnedShop(db, userId, shopId) {
  return db.get('SELECT * FROM shops WHERE id = ? AND user_id = ?', [shopId, userId]);
}

async function requireOwnedShop(req, res, nextOrId) {
  const isMiddleware = typeof nextOrId === 'function';
  const shopId = isMiddleware ? (req.params.shopId || req.body.shopId || req.query.shopId) : nextOrId;

  if (!shopId) {
    return res.status(400).json({
      error: 'shopId required',
      message: 'กรุณาระบุ shopId'
    });
  }

  const db = getDb();
  const shop = await getOwnedShop(db, req.userId, shopId);

  if (!shop) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'คุณไม่มีสิทธิ์เข้าถึงร้านค้านี้'
    });
  }

  req.shopId = shop.id;
  req.shop = shop;

  if (isMiddleware) {
    return nextOrId();
  }

  return shop;
}

module.exports = {
  getOwnedShop,
  requireOwnedShop
};
