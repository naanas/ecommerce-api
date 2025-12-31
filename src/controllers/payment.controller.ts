import { Request, Response } from 'express';
import axios from 'axios';

export class PaymentController {
  
  static async getPaymentFee(req: Request, res: Response) {
    try {
      const { code } = req.query; 
      
      // 1. Validasi Input
      if (!code || typeof code !== 'string') {
        return res.status(400).json({ 
          success: false, 
          error: 'Parameter payment method code wajib diisi.' 
        });
      }

      const orchestratorUrl = process.env.PAYMENT_ORCHESTRATOR_URL;
      if (!orchestratorUrl) {
        console.error('CRITICAL: PAYMENT_ORCHESTRATOR_URL is missing');
        return res.status(500).json({ error: 'Internal Server Configuration Error' });
      }

      // 2. Request ke Orchestrator (Endpoint Orchestrator harus /api/admin/config)
      // Kita tidak mengirim 'amount' karena orchestrator hanya butuh 'code' untuk cek fee
      const response = await axios.get(`${orchestratorUrl}/api/admin/config`, {
        params: { code },
        timeout: 5000 
      });

      // 3. Return data sukses dari Orchestrator ke Frontend
      return res.json(response.data);

    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        if (error.response) {
          console.warn(`[Proxy Error] Orchestrator returned ${error.response.status}:`, error.response.data);
          return res.status(error.response.status).json(error.response.data);
        } else if (error.request) {
          console.error('[Proxy Error] No response from Orchestrator');
          return res.status(503).json({ 
            success: false, 
            error: 'Layanan pembayaran sedang tidak tersedia.' 
          });
        }
      }

      console.error("Internal Payment Controller Error:", error);
      return res.status(500).json({ 
        success: false, 
        error: 'Terjadi kesalahan internal pada server.' 
      });
    }
  }
}