const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const { requireOwnedShop } = require('../middleware/shopAccess');

router.use(authMiddleware);

function getOwnedProject(db, userId, projectId) {
  return db.prepare(`
    SELECT p.*
    FROM projects p
    JOIN shops s ON s.id = p.shop_id
    WHERE p.id = ? AND s.user_id = ?
  `).get(projectId, userId);
}

function getOwnedTask(db, userId, taskId) {
  return db.prepare(`
    SELECT pt.*, p.shop_id
    FROM project_tasks pt
    JOIN projects p ON p.id = pt.project_id
    JOIN shops s ON s.id = p.shop_id
    WHERE pt.id = ? AND s.user_id = ?
  `).get(taskId, userId);
}

router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.query;

    if (!shopId) {
      return res.status(400).json({ error: 'shopId is required' });
    }

    if (!requireOwnedShop(req, res, shopId)) return;

    const projects = db.prepare(
      'SELECT * FROM projects WHERE shop_id = ? ORDER BY created_at DESC'
    ).all(req.shopId);
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { name, description, status, shopId } = req.body;

    if (!shopId || !name) {
      return res.status(400).json({ error: 'shopId and name are required' });
    }

    if (!requireOwnedShop(req, res, shopId)) return;

    const result = db.prepare(`
      INSERT INTO projects (name, description, status, shop_id, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(name, description || '', status || 'active', req.shopId);

    res.json({ id: result.lastInsertRowid, name, description, status: status || 'active', shopId: req.shopId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const { name, description, status } = req.body;
    const project = getOwnedProject(db, req.userId, req.params.id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    db.prepare(`
      UPDATE projects SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        status = COALESCE(?, status),
        updated_at = datetime('now')
      WHERE id = ? AND shop_id = ?
    `).run(name, description, status, req.params.id, project.shop_id);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const project = getOwnedProject(db, req.userId, req.params.id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    db.prepare('DELETE FROM projects WHERE id = ? AND shop_id = ?').run(req.params.id, project.shop_id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tasks', (req, res) => {
  try {
    const db = getDb();
    const { shopId, projectId } = req.query;

    if (projectId) {
      const project = getOwnedProject(db, req.userId, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const tasks = db.prepare(
        'SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at DESC'
      ).all(projectId);
      return res.json(tasks);
    }

    if (!shopId) {
      return res.status(400).json({ error: 'shopId or projectId is required' });
    }

    if (!requireOwnedShop(req, res, shopId)) return;

    const tasks = db.prepare(`
      SELECT pt.* FROM project_tasks pt
      JOIN projects p ON pt.project_id = p.id
      WHERE p.shop_id = ?
      ORDER BY pt.created_at DESC
    `).all(req.shopId);

    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/tasks', (req, res) => {
  try {
    const db = getDb();
    const { title, description, priority, status, projectId, dueDate } = req.body;

    if (!projectId || !title) {
      return res.status(400).json({ error: 'projectId and title are required' });
    }

    const project = getOwnedProject(db, req.userId, projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const result = db.prepare(`
      INSERT INTO project_tasks (title, description, priority, status, project_id, due_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(title, description || '', priority || 'medium', status || 'todo', projectId, dueDate || null);

    res.json({
      id: result.lastInsertRowid,
      title,
      description,
      priority: priority || 'medium',
      status: status || 'todo',
      projectId
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/tasks/:id', (req, res) => {
  try {
    const db = getDb();
    const { title, description, priority, status, dueDate } = req.body;
    const task = getOwnedTask(db, req.userId, req.params.id);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    db.prepare(`
      UPDATE project_tasks
      SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        priority = COALESCE(?, priority),
        status = COALESCE(?, status),
        due_date = COALESCE(?, due_date),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(title, description, priority, status, dueDate, req.params.id);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/tasks/:id', (req, res) => {
  try {
    const db = getDb();
    const task = getOwnedTask(db, req.userId, req.params.id);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    db.prepare('DELETE FROM project_tasks WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
