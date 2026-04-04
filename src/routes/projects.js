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

async function getOwnedProject(db, userId, projectId) {
  return db.get(`
    SELECT p.*
    FROM projects p
    JOIN shops s ON s.id = p.shop_id
    WHERE p.id = ? AND s.user_id = ?
  `, [projectId, userId]);
}

async function getOwnedTask(db, userId, taskId) {
  return db.get(`
    SELECT pt.*, p.shop_id
    FROM project_tasks pt
    JOIN projects p ON p.id = pt.project_id
    JOIN shops s ON s.id = p.shop_id
    WHERE pt.id = ? AND s.user_id = ?
  `, [taskId, userId]);
}

router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.query;

    if (!shopId) {
      return res.status(400).json({ error: 'shopId is required' });
    }

    if (!await requireOwnedShop(req, res, shopId)) return;

    const projects = await db.all(
      'SELECT * FROM projects WHERE shop_id = ? ORDER BY created_at DESC',
      [req.shopId]
    );
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const db = getDb();
    const { name, description, status, shopId } = req.body;

    if (!shopId || !name) {
      return res.status(400).json({ error: 'shopId and name are required' });
    }

    if (!await requireOwnedShop(req, res, shopId)) return;

    const safeName = stripHtml(name);
    const safeDesc = stripHtml(description || '');

    const result = await db.run(`
      INSERT INTO projects (name, description, status, shop_id, created_at)
      VALUES (?, ?, ?, ?, NOW()) RETURNING id
    `, [safeName, safeDesc, status || 'active', req.shopId]);

    res.json({ id: result.lastInsertRowid, name: safeName, description: safeDesc, status: status || 'active', shopId: req.shopId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const db = getDb();
    const { name, description, status } = req.body;
    const project = await getOwnedProject(db, req.userId, req.params.id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await db.run(`
      UPDATE projects SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        status = COALESCE(?, status),
        updated_at = NOW()
      WHERE id = ? AND shop_id = ?
    `, [name ? stripHtml(name) : null, description ? stripHtml(description) : null, status, req.params.id, project.shop_id]);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const project = await getOwnedProject(db, req.userId, req.params.id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await db.run('DELETE FROM projects WHERE id = ? AND shop_id = ?', [req.params.id, project.shop_id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tasks', async (req, res) => {
  try {
    const db = getDb();
    const { shopId, projectId } = req.query;

    if (projectId) {
      const project = await getOwnedProject(db, req.userId, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const tasks = await db.all(
        'SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at DESC',
        [projectId]
      );
      return res.json(tasks);
    }

    if (!shopId) {
      return res.status(400).json({ error: 'shopId or projectId is required' });
    }

    if (!await requireOwnedShop(req, res, shopId)) return;

    const tasks = await db.all(`
      SELECT pt.* FROM project_tasks pt
      JOIN projects p ON pt.project_id = p.id
      WHERE p.shop_id = ?
      ORDER BY pt.created_at DESC
    `, [req.shopId]);

    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/tasks', async (req, res) => {
  try {
    const db = getDb();
    const { title, description, priority, status, projectId, dueDate } = req.body;

    if (!projectId || !title) {
      return res.status(400).json({ error: 'projectId and title are required' });
    }

    const project = await getOwnedProject(db, req.userId, projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const safeTitle = stripHtml(title);
    const safeTaskDesc = stripHtml(description || '');

    const result = await db.run(`
      INSERT INTO project_tasks (title, description, priority, status, project_id, due_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW()) RETURNING id
    `, [safeTitle, safeTaskDesc, priority || 'medium', status || 'todo', projectId, dueDate || null]);

    res.json({
      id: result.lastInsertRowid,
      title: safeTitle,
      description: safeTaskDesc,
      priority: priority || 'medium',
      status: status || 'todo',
      projectId
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/tasks/:id', async (req, res) => {
  try {
    const db = getDb();
    const { title, description, priority, status, dueDate } = req.body;
    const task = await getOwnedTask(db, req.userId, req.params.id);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    await db.run(`
      UPDATE project_tasks
      SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        priority = COALESCE(?, priority),
        status = COALESCE(?, status),
        due_date = COALESCE(?, due_date),
        updated_at = NOW()
      WHERE id = ?
    `, [title ? stripHtml(title) : null, description ? stripHtml(description) : null, priority, status, dueDate, req.params.id]);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/tasks/:id', async (req, res) => {
  try {
    const db = getDb();
    const task = await getOwnedTask(db, req.userId, req.params.id);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    await db.run('DELETE FROM project_tasks WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
