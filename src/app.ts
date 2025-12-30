import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import router from './routes';
import './jobs/expireOrders';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware standar
app.use(cors());
app.use(express.json());

// ==========================================
// LOGGER MIDDLEWARE (BARU DITAMBAHKAN)
// ==========================================
app.use((req, res, next) => {
  const start = Date.now(); // Catat waktu mulai request

  // Event listener: akan jalan ketika response selesai dikirim ke user
  res.on('finish', () => {
    const duration = Date.now() - start;
    const time = new Date().toLocaleTimeString('id-ID', { hour12: false }); // Format jam lokal (24 jam)
    
    // Warnai output terminal (Opsional, agar lebih mudah dibaca)
    // Hijau untuk sukses (2xx), Merah untuk error (4xx, 5xx), Kuning untuk lainnya
    let statusColor = res.statusCode >= 400 ? '\x1b[31m' : res.statusCode >= 300 ? '\x1b[33m' : '\x1b[32m';
    const resetColor = '\x1b[0m';

    // Format Log: [JAM] METHOD URL STATUS - DURASI
    console.log(
      `[${time}] ${req.method} ${req.originalUrl} ${statusColor}${res.statusCode}${resetColor} - ${duration}ms`
    );
  });

  next(); // Lanjut ke proses route selanjutnya
});
// ==========================================

// Default Route
app.get('/', (req, res) => {
  res.send('Ecommerce API is running...');
});

// Main Routes
app.use('/api', router);

// Start Server
app.listen(PORT, () => {
  console.log(`Ecommerce Backend running on http://localhost:${PORT}`);
  // Menampilkan info integration target dari env jika ada
  if (process.env.PAYMENT_ORCHESTRATOR_URL) {
    console.log(`Integration Target: ${process.env.PAYMENT_ORCHESTRATOR_URL}`);
  }
});