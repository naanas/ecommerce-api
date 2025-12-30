import { Request, Response } from 'express';
import axios, { AxiosError } from 'axios';

export class PaymentController {
  
  static async getPaymentFee(req: Request, res: Response) {
    try {
      const { code } = req.query; 
      
      // 1. Validasi Input Dasar
      if (!code || typeof code !== 'string') {
        return res.status(400).json({ 
          success: false, 
          error: 'Parameter payment method code wajib diisi.' 
        });
      }

      const orchestratorUrl = process.env.PAYMENT_ORCHESTRATOR_URL;
      if (!orchestratorUrl) {
        // Ini adalah kesalahan konfigurasi server (Critical)
        console.error('CRITICAL: PAYMENT_ORCHESTRATOR_URL is missing');
        return res.status(500).json({ error: 'Internal Server Configuration Error' });
      }

      // 2. Request ke Orchestrator dengan Timeout
      // Penting: Tambahkan timeout agar request tidak hang selamanya jika orchestrator down
      const response = await axios.get(`${orchestratorUrl}/api/admin/config`, {
        params: { code },
        timeout: 5000 // Maksimal tunggu 5 detik
      });

      // 3. Return data sukses
      return res.json(response.data);

    } catch (error: any) {
      // 4. Advanced Error Handling (Standar Proxy)
      
      if (axios.isAxiosError(error)) {
        // Jika Orchestrator merespons dengan error (4xx, 5xx)
        if (error.response) {
          console.warn(`[Proxy Error] Orchestrator returned ${error.response.status}:`, error.response.data);
          
          // FORWARD status code dan pesan error dari Orchestrator ke Frontend
          return res.status(error.response.status).json(error.response.data);
        } else if (error.request) {
          // Jika Orchestrator tidak bisa dihubungi (Network Error / Down)
          console.error('[Proxy Error] No response from Orchestrator');
          return res.status(503).json({ 
            success: false, 
            error: 'Layanan pembayaran sedang tidak tersedia, coba lagi nanti.' 
          });
        }
      }

      // Jika error kode internal Javascript lainnya
      console.error("Internal Payment Controller Error:", error);
      return res.status(500).json({ 
        success: false, 
        error: 'Terjadi kesalahan internal pada server.' 
      });
    }
  }
}