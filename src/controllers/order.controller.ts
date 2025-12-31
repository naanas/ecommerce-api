import { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import axios from 'axios';
import crypto from 'crypto'; 

// Interface Response dari Payment Orchestrator
interface OrchestratorResponse {
  success: boolean;
  data: {
    transaction_id: string;
    payment_url?: string;
    virtual_account?: string;
    qr_code?: string;
    status: string;
    amount: number;
  };
}

export class OrderController {
  
  // =================================================================
  // HELPER: Fetch Fee dari Orchestrator (Backend-to-Backend)
  // =================================================================
  private static async fetchAdminFee(paymentCode: string): Promise<number> {
    const orchestratorUrl = process.env.PAYMENT_ORCHESTRATOR_URL;
    if (!orchestratorUrl) return 0;

    try {
      const res = await axios.get(`${orchestratorUrl.replace(/\/$/, '')}/api/admin/config`, {
        params: { code: paymentCode },
        timeout: 5000 
      });

      if (res.data && res.data.success) {
        return Number(res.data.data.admin_fee || 0);
      }
      return 0;
    } catch (error) {
      console.warn(`⚠️ Gagal mengambil fee untuk ${paymentCode}, default ke 0. Error:`, (error as any).message);
      return 0;
    }
  }

  // =================================================================
  // 1. CREATE ORDER (Checkout)
  // =================================================================
  static async createOrder(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      
      // 1. Validasi Auth
      if (!user) return res.status(401).json({ error: 'User not authenticated' });
      if (!user.phone) {
        return res.status(400).json({ error: 'Nomor HP wajib diisi. Mohon update profil.' });
      }

      const { items, payment_method_code } = req.body as any;

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Tidak ada barang yang di-checkout' });
      }

      // 2. Variable untuk kalkulasi
      let productTotal = 0;
      const orderItemsData: any[] = [];
      const productsToUpdate: any[] = [];
      const purchasedProductIds: any[] = []; 

      // ==========================================================
      // TAHAP 1: VALIDASI STOK, HARGA & SELF-BUY
      // ==========================================================
      for (const item of (items as any[])) {
        const { data: product } = await supabase
          .from('products')
          .select('*')
          .eq('id', item.product_id)
          .single();
        
        if (!product) {
          return res.status(404).json({ error: `Produk ID ${item.product_id} tidak ditemukan` });
        }

        if (product.seller_id === user.id) {
          return res.status(400).json({ error: `Anda tidak bisa membeli produk sendiri: ${product.name}` });
        }

        if (product.stock < item.quantity) {
          return res.status(400).json({ error: `Stok habis untuk produk: ${product.name}` });
        }

        productTotal += product.price * item.quantity;
        
        orderItemsData.push({
          product_id: product.id,
          quantity: item.quantity,
          price_at_purchase: product.price 
        });

        productsToUpdate.push({
          id: product.id,
          newStock: product.stock - item.quantity
        });

        purchasedProductIds.push(product.id);
      }

      // ==========================================================
      // TAHAP 2: HITUNG TOTAL AKHIR (SERVER SIDE CALCULATION)
      // ==========================================================
      const adminFee = await OrderController.fetchAdminFee(payment_method_code);
      const finalTotalAmount = productTotal + adminFee;

      console.log(`💰 Calculation: Products Rp${productTotal} + Fee Rp${adminFee} = Total Rp${finalTotalAmount}`);

      // ==========================================================
      // TAHAP 3: DATABASE TRANSACTION (SIMPAN ORDER)
      // ==========================================================
      
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
          buyer_id: user.id,
          total_amount: finalTotalAmount, 
          admin_fee: adminFee, 
          status: 'PENDING'
          // [FIX] Baris payment_method dihapus karena kolom belum ada di DB
        })
        .select()
        .single();

      if (orderError) {
         console.error("Database Insert Error:", orderError); // Tambahan Log biar jelas
         throw orderError;
      }

      // Buat Order Items
      const itemsToInsert = orderItemsData.map(i => ({
        ...i,
        order_id: order.id
      }));

      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(itemsToInsert);

      if (itemsError) throw itemsError;

      // Potong Stok Produk
      for (const prod of productsToUpdate) {
        await supabase
          .from('products')
          .update({ stock: prod.newStock })
          .eq('id', prod.id);
      }

      // ==========================================================
      // TAHAP 4: BERSIHKAN KERANJANG
      // ==========================================================
      if (purchasedProductIds.length > 0) {
          await supabase
            .from('cart_items')
            .delete()
            .eq('user_id', user.id)
            .in('product_id', purchasedProductIds);
          
          console.log(`🛒 Menghapus ${purchasedProductIds.length} item dari keranjang.`);
      }

      // ==========================================================
      // TAHAP 5: INTEGRASI PAYMENT ORCHESTRATOR
      // ==========================================================
      try {
        const orchestratorUrl = process.env.PAYMENT_ORCHESTRATOR_URL;
        const serverKey = process.env.PAYMENT_SERVER_KEY || process.env.ORCHESTRATOR_SERVER_KEY; 

        if (!orchestratorUrl || !serverKey) {
            throw new Error('Konfigurasi Payment (URL/Key) hilang di .env');
        }

        const endpoint = `${orchestratorUrl.replace(/\/$/, '')}/api/payments/create`;

        const payload = {
          reference_id: order.id, 
          amount: finalTotalAmount, 
          payment_method: payment_method_code || 'BCA_VA', // Dikirim ke Orchestrator tapi tidak di save di DB kita
          customer_name: user.name || 'Pelanggan',
          customer_email: user.email,
          customer_phone: user.phone,
          description: `Order #${order.id.substring(0, 8)}`
        };

        console.log(`[BACKEND] Request Payment: ${endpoint}`);

        const orchestratorResponse = await axios.post<OrchestratorResponse>(
          endpoint, 
          payload,
          {
            headers: {
              'Content-Type': 'application/json',
              'x-server-key': serverKey
            }
          }
        );

        const paymentData = orchestratorResponse.data.data;
        
        // Update Order dengan Transaction ID
        await supabase
          .from('orders')
          .update({ payment_id: paymentData.transaction_id })
          .eq('id', order.id);

        // Notifikasi
        try {
            await supabase.from('notifications').insert({
                user_id: user.id, 
                title: 'Pesanan Dibuat 📦',
                message: `Pesanan #${order.id.substring(0, 8)} berhasil dibuat. Total tagihan Rp${finalTotalAmount.toLocaleString('id-ID')}.`,
                is_read: false
            });
        } catch (err) {
            console.error("Ignored Error (Notif):", err);
        }

        res.status(201).json({
          success: true,
          data: {
            order_id: order.id,
            total_amount: finalTotalAmount,
            admin_fee: adminFee,
            status: 'PENDING',
            payment_id: paymentData.transaction_id,
            payment_details: paymentData
          }
        });

      } catch (paymentError: any) {
        console.error("!!! GAGAL MENGHUBUNGI ORCHESTRATOR !!!");
        if (paymentError.response) {
            console.error("Status:", paymentError.response.status);
            console.error("Response:", paymentError.response.data);
        } else {
            console.error("Error:", paymentError.message);
        }
        
        res.status(201).json({ 
            success: false, 
            message: "Order dibuat tapi pembayaran gagal diinisiasi. Silakan cek menu Pesanan Saya.",
            data: { 
                order_id: order.id,
                total_amount: finalTotalAmount,
                status: 'PENDING',
                payment_id: null 
            } 
        });
      }

    } catch (error: any) {
      console.error("Create Order Fatal Error:", error.message);
      res.status(500).json({ error: error.message });
    }
  }

  // =================================================================
  // 2. WEBHOOK HANDLER
  // =================================================================
  static async handleWebhook(req: Request, res: Response) {
    try {
      const { transaction_id, status } = req.body;
      const signature = req.headers['x-signature'] as string;
      const secret = process.env.WEBHOOK_SECRET || 'rahasia-super-aman'; 

      console.log(`🔔 Webhook received for ${transaction_id}: ${status}`);

      if (!signature) return res.status(401).json({ error: 'Missing Signature' });

      const computedSignature = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (signature !== computedSignature) {
        console.warn(`⛔ Invalid Signature!`);
        return res.status(403).json({ error: 'Invalid Signature' });
      }

      if (!transaction_id || !status) return res.status(400).json({ error: 'Invalid payload' });

      const { data: order } = await supabase
        .from('orders')
        .select('id, buyer_id') 
        .eq('payment_id', transaction_id)
        .single();

      if (!order) {
        console.warn(`⚠️ Order not found for Transaction: ${transaction_id}`);
        return res.status(404).json({ error: 'Order not found' });
      }

      const { error: updateError } = await supabase
        .from('orders')
        .update({ status: status })
        .eq('id', order.id);

      if (updateError) throw updateError;

      if (status === 'SUCCESS' || status === 'FAILED') {
          const title = status === 'SUCCESS' ? 'Pembayaran Berhasil! 🎉' : 'Pembayaran Gagal ❌';
          const message = status === 'SUCCESS' 
            ? `Pesanan #${order.id.substring(0,8)} telah lunas.` 
            : `Pembayaran untuk pesanan #${order.id.substring(0,8)} gagal.`;

          if (order.buyer_id) {
              await supabase.from('notifications').insert({
                  user_id: order.buyer_id,
                  title: title,
                  message: message,
                  is_read: false
              });
          }
      }

      res.json({ success: true, message: 'Order updated' });

    } catch (error: any) {
      console.error("Webhook Error:", error.message);
      res.status(500).json({ error: error.message });
    }
  }

  // =================================================================
  // 3. GET MY ORDERS
  // =================================================================
  static async getMyOrders(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { data, error } = await supabase
        .from('orders')
        .select('*, order_items(*, products(*))') 
        .eq('buyer_id', user.id)
        .order('created_at', { ascending: false });
      
      if (error) throw error;

      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}