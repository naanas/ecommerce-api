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

      // Ambil data dari body
      const { items, payment_method_code, admin_fee } = req.body as any;

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Tidak ada barang yang di-checkout' });
      }

      // 2. Variable untuk kalkulasi
      let productTotal = 0;
      const orderItemsData: any[] = [];
      const productsToUpdate: any[] = [];
      // [FIX] Array untuk menampung ID produk yang dibeli (buat hapus keranjang nanti)
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

        // Validasi: Tidak boleh beli barang sendiri
        if (product.seller_id === user.id) {
          return res.status(400).json({ error: `Anda tidak bisa membeli produk sendiri: ${product.name}` });
        }

        // Cek Stok
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

        // [FIX] Masukkan ID produk ke list yang akan dihapus dari keranjang
        purchasedProductIds.push(product.id);
      }

      // Hitung Total Akhir (Barang + Admin Fee)
      const fee = Number(admin_fee) || 0;
      const finalTotalAmount = productTotal + fee;

      // ==========================================================
      // TAHAP 2: DATABASE TRANSACTION (SIMPAN ORDER)
      // ==========================================================
      
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
          buyer_id: user.id,
          total_amount: finalTotalAmount, 
          admin_fee: fee,                 
          status: 'PENDING'
        })
        .select()
        .single();

      if (orderError) throw orderError;

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
      // [FIXED] BERSIHKAN KERANJANG (HANYA YANG DIBELI)
      // ==========================================================
      if (purchasedProductIds.length > 0) {
          await supabase
            .from('cart_items')
            .delete()
            .eq('user_id', user.id)
            .in('product_id', purchasedProductIds); // <--- Hapus cuma yang ada di list ini
          
          console.log(`🛒 Menghapus ${purchasedProductIds.length} item spesifik dari keranjang.`);
      }

      // ==========================================================
      // TAHAP 3: INTEGRASI PAYMENT ORCHESTRATOR
      // ==========================================================
      try {
        const orchestratorUrl = process.env.PAYMENT_ORCHESTRATOR_URL;
        const serverKey = process.env.PAYMENT_SERVER_KEY;

        if (!orchestratorUrl || !serverKey) {
            throw new Error('Konfigurasi Payment (URL/Key) hilang di .env');
        }

        const endpoint = `${orchestratorUrl.replace(/\/$/, '')}/api/payments/create`;

        const payload = {
          order_id: order.id,
          reference_id: order.id, // Idempotency Key
          amount: finalTotalAmount, 
          payment_method: payment_method_code || 'BCA_VA',
          customer_name: user.name || 'Pelanggan',
          customer_email: user.email,
          customer_phone: user.phone,
          description: `Order #${order.id.substring(0, 8)}`
        };

        console.log(`[BACKEND] Request ke Orchestrator: ${endpoint}`);

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
        
        // Update Order dengan Transaction ID dari Orchestrator
        await supabase
          .from('orders')
          .update({ payment_id: paymentData.transaction_id })
          .eq('id', order.id);

        // ============================================================
        // [BARU] INSERT NOTIFIKASI "PESANAN DIBUAT" 📦
        // ============================================================
        try {
            const { error: notifError } = await supabase.from('notifications').insert({
                user_id: user.id, 
                title: 'Pesanan Dibuat 📦',
                message: `Pesanan #${order.id.substring(0, 8)} berhasil dibuat. Silakan selesaikan pembayaran sebesar Rp${finalTotalAmount.toLocaleString('id-ID')}.`,
                is_read: false
            });

            if (notifError) {
                console.error("⚠️ Gagal buat notif create order:", notifError.message);
            } else {
                console.log(`✅ Notif Create Order sent to User ${user.id}`);
            }
        } catch (err) {
            console.error("Ignored Error (Notif):", err);
        }
        // ============================================================

        res.status(201).json({
          success: true,
          data: {
            order_id: order.id,
            total_amount: finalTotalAmount,
            admin_fee: fee,
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
        
        // Tetap return success true agar order tidak hilang, user bisa coba bayar lagi nanti
        res.status(201).json({ 
            success: false, 
            message: "Order berhasil dibuat, namun pembayaran gagal diinisiasi. Cek Pesanan Saya.",
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

      // 1. Validasi Keberadaan Signature
      if (!signature) {
        console.warn("⛔ Missing Signature");
        return res.status(401).json({ error: 'Missing Signature' });
      }

      // 2. Hitung Ulang Signature
      const computedSignature = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex');

      // 3. Security Check
      if (signature !== computedSignature) {
        console.warn(`⛔ Invalid Signature! Potential Hacker!`);
        return res.status(403).json({ error: 'Invalid Signature' });
      }

      if (!transaction_id || !status) return res.status(400).json({ error: 'Invalid payload' });

      // 4. Cari order & Select Buyer ID (PENTING)
      const { data: order } = await supabase
        .from('orders')
        .select('id, buyer_id') 
        .eq('payment_id', transaction_id)
        .single();

      if (!order) {
        console.warn(`⚠️ Order not found for Transaction: ${transaction_id}`);
        return res.status(404).json({ error: 'Order not found' });
      }

      // 5. Update status order
      const { error: updateError } = await supabase
        .from('orders')
        .update({ status: status })
        .eq('id', order.id);

      if (updateError) throw updateError;

      // ==========================================
      // INSERT NOTIFIKASI (WEBHOOK)
      // ==========================================
      if (status === 'SUCCESS' || status === 'FAILED') {
          const title = status === 'SUCCESS' ? 'Pembayaran Berhasil! 🎉' : 'Pembayaran Gagal ❌';
          const message = status === 'SUCCESS' 
            ? `Pesanan #${order.id.substring(0,8)} telah lunas. Penjual akan segera memprosesnya.` 
            : `Pembayaran untuk pesanan #${order.id.substring(0,8)} gagal. Silakan coba lagi.`;

          if (order.buyer_id) {
              const { error: notifError } = await supabase.from('notifications').insert({
                  user_id: order.buyer_id,
                  title: title,
                  message: message,
                  is_read: false
              });
              
              if (notifError) {
                  console.error("❌ GAGAL INSERT NOTIFIKASI WEBHOOK:", notifError.message);
              } else {
                  console.log(`✅ Notifikasi Webhook berhasil disimpan untuk User ${order.buyer_id}`);
              }
          } else {
              console.warn("⚠️ Buyer ID null, skip notification");
          }
      }

      res.json({ success: true, message: 'Order status updated & notification processed' });

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