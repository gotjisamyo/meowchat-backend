const express = require('express');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { Readable } = require('stream');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB

// Configure Cloudinary from env vars
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// POST /api/upload/image — upload image to Cloudinary, return URL (auth applied at app level)
router.post('/image', upload.single('file'), async (req, res) => {
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return res.status(503).json({ error: 'Image upload not configured (missing CLOUDINARY_CLOUD_NAME)' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }
  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'meowchat', resource_type: 'image' },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      Readable.from(req.file.buffer).pipe(stream);
    });
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error('[upload] Cloudinary error:', err.message);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

module.exports = router;
