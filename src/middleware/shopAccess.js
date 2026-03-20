const { getDb } = require('../db');

function getOwnedShop(db, userId, shopId) {
  return db
    .prepare('SELECT * FROM shops WHERE id = ? AND user_id = ?')
    .get(shopId, userId);
}

function requireOwnedShop(req, res, shopId) {
  const db = getDb();
  const shop = getOwnedShop(db, req.userId, shopId);

  if (!shop) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'คุณไม่มีสิทธิ์เข้าถึงร้านค้านี้'
    });
    return null;
  }

  req.shopId = shop.id;
  req.shop = shop;
  return shop;
}

module.exports = {
  getOwnedShop,
  requireOwnedShop
};
