const express = require('express');
const router = express.Router();

// GET /api/leads/media/:mediaId — proxy público de media de Meta.
// SIN auth: lo consumen <img>/<audio>/<a> del navegador que no pueden
// adjuntar el header Authorization. Requiere un media_id opaco de Meta.
router.get('/:mediaId', async (req, res) => {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v19.0/${req.params.mediaId}`, {
      headers: { Authorization: `Bearer ${process.env.META_TOKEN}` },
    });
    if (!metaRes.ok) throw new Error(`Meta metadata error: ${await metaRes.text()}`);
    const { url } = await metaRes.json();

    const fileRes = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.META_TOKEN}` },
    });
    if (!fileRes.ok) throw new Error('Meta media download error');

    res.setHeader('Content-Type', fileRes.headers.get('content-type') || 'application/octet-stream');
    const buf = await fileRes.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
