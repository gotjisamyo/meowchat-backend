const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const { requireOwnedShop } = require('../middleware/shopAccess');

router.use(authMiddleware);

function getOwnedProduct(db, userId, productId) {
  return db.prepare(`
    SELECT p.*
    FROM products p
    JOIN shops s ON s.id = p.shop_id
    WHERE p.id = ? AND s.user_id = ?
  `).get(productId, userId);
}

// Get products by shop
router.get('/:shopId', (req, res) => {
  try {
    const { shopId } = req.params;
    if (!requireOwnedShop(req, res, shopId)) {
      return;
    }

    const db = getDb();
    const products = db.prepare(
      'SELECT * FROM products WHERE shop_id = ? ORDER BY createdAt DESC'
    ).all(req.shopId);
    res.json(products);
  } catch (error) {
    console.error('Error getting products:', error);
    res.status(500).json({ error: 'Failed to get products' });
  }
});

// Add product
router.post('/', (req, res) => {
  try {
    const { shopId, name, description, price, stock, imageUrl, category } = req.body;

    if (!shopId || !name) {
      return res.status(400).json({ error: 'shopId and name are required' });
    }

    if (!requireOwnedShop(req, res, shopId)) {
      return;
    }

    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO products (shop_id, name, description, price, stock, imageUrl, category, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `);

    const result = stmt.run(
      req.shopId,
      name,
      description || '',
      price || 0,
      stock || 0,
      imageUrl || '',
      category || ''
    );

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
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, stock, imageUrl, category, status } = req.body;
    const db = getDb();

    const existingProduct = getOwnedProduct(db, req.userId, id);
    if (!existingProduct) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const fields = [];
    const values = [];

    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    if (price !== undefined) { fields.push('price = ?'); values.push(price); }
    if (stock !== undefined) { fields.push('stock = ?'); values.push(stock); }
    if (imageUrl !== undefined) { fields.push('imageUrl = ?'); values.push(imageUrl); }
    if (category !== undefined) { fields.push('category = ?'); values.push(category); }
    if (status !== undefined) { fields.push('status = ?'); values.push(status); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    fields.push('updatedAt = CURRENT_TIMESTAMP');
    values.push(id, req.userId);

    const stmt = db.prepare(`
      UPDATE products
      SET ${fields.join(', ')}
      WHERE id = ?
        AND shop_id IN (SELECT id FROM shops WHERE user_id = ?)
    `);
    stmt.run(...values);

    res.json({ success: true, message: 'อัพเดทสินค้าสำเร็จ' });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete product
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const existingProduct = getOwnedProduct(db, req.userId, id);
    if (!existingProduct) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const stmt = db.prepare(`
      DELETE FROM products
      WHERE id = ?
        AND shop_id IN (SELECT id FROM shops WHERE user_id = ?)
    `);
    stmt.run(id, req.userId);
    res.json({ success: true, message: 'ลบสินค้าสำเร็จ' });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

module.exports = router;
