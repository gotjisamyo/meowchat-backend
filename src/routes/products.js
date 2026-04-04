const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const { requireOwnedShop } = require('../middleware/shopAccess');

router.use(authMiddleware);

function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').trim();
}

async function getOwnedProduct(db, userId, productId) {
  return db.get(`
    SELECT p.*
    FROM products p
    JOIN shops s ON s.id = p.shop_id
    WHERE p.id = ? AND s.user_id = ?
  `, [productId, userId]);
}

// Get products by shop
router.get('/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    if (!await requireOwnedShop(req, res, shopId)) {
      return;
    }

    const db = getDb();
    const products = await db.all(
      'SELECT * FROM products WHERE shop_id = ? ORDER BY "createdAt" DESC',
      [req.shopId]
    );
    res.json(products);
  } catch (error) {
    console.error('Error getting products:', error);
    res.status(500).json({ error: 'Failed to get products' });
  }
});

// Add product
router.post('/', async (req, res) => {
  try {
    const { shopId, name, description, price, stock, imageUrl, category } = req.body;

    if (!shopId || !name) {
      return res.status(400).json({ error: 'shopId and name are required' });
    }

    if (!await requireOwnedShop(req, res, shopId)) {
      return;
    }

    const db = getDb();
    const result = await db.run(`
      INSERT INTO products (shop_id, name, description, price, stock, "imageUrl", category, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active') RETURNING id
    `, [
      req.shopId,
      stripHtml(name),
      stripHtml(description || ''),
      price || 0,
      stock || 0,
      stripHtml(imageUrl || ''),
      stripHtml(category || '')
    ]);

    res.json({
      success: true,
      id: result.lastInsertRowid,
      message: 'เพิ่มสินค้าสำเร็จ'
    });
  } catch (error) {
    console.error('Error adding product:', error);
    res.status(500).json({ error: 'Failed to add product' });
  }
});

// Update product
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, stock, imageUrl, category, status } = req.body;
    const db = getDb();

    const existingProduct = await getOwnedProduct(db, req.userId, id);
    if (!existingProduct) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const fields = [];
    const values = [];

    if (name !== undefined) { fields.push('name = ?'); values.push(stripHtml(name)); }
    if (description !== undefined) { fields.push('description = ?'); values.push(stripHtml(description)); }
    if (price !== undefined) { fields.push('price = ?'); values.push(price); }
    if (stock !== undefined) { fields.push('stock = ?'); values.push(stock); }
    if (imageUrl !== undefined) { fields.push('"imageUrl" = ?'); values.push(stripHtml(imageUrl)); }
    if (category !== undefined) { fields.push('category = ?'); values.push(stripHtml(category)); }
    if (status !== undefined) { fields.push('status = ?'); values.push(status); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    fields.push('"updatedAt" = CURRENT_TIMESTAMP');
    values.push(id, req.userId);

    await db.run(`
      UPDATE products
      SET ${fields.join(', ')}
      WHERE id = ?
        AND shop_id IN (SELECT id FROM shops WHERE user_id = ?)
    `, values);

    res.json({ success: true, message: 'อัพเดทสินค้าสำเร็จ' });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete product
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const existingProduct = await getOwnedProduct(db, req.userId, id);
    if (!existingProduct) {
      return res.status(404).json({ error: 'Product not found' });
    }

    await db.run(`
      DELETE FROM products
      WHERE id = ?
        AND shop_id IN (SELECT id FROM shops WHERE user_id = ?)
    `, [id, req.userId]);
    res.json({ success: true, message: 'ลบสินค้าสำเร็จ' });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

module.exports = router;
