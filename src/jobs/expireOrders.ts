import cron from 'node-cron';
import { supabase } from '../config/supabase';

// Jalankan setiap 30 menit
// Format Cron: "*/30 * * * *" artinya setiap menit ke-30
cron.schedule('*/30 * * * *', async () => {
  console.log('🧹 [CRON] Running Cleanup Job: Checking expired orders...');

  try {
    // 1. Batas waktu (misal: order dibuat 24 jam lalu dan masih PENDING)
    const expiryTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    // 2. Cari order yang kadaluarsa
    const { data: expiredOrders, error } = await supabase
      .from('orders')
      .select('id, status, order_items(product_id, quantity)')
      .eq('status', 'PENDING')
      .lt('created_at', expiryTime);

    if (error) throw error;

    if (!expiredOrders || expiredOrders.length === 0) {
      console.log('✅ [CRON] No expired orders found.');
      return;
    }

    console.log(`found ${expiredOrders.length} expired orders. Processing...`);

    // 3. Loop setiap order untuk batalkan dan kembalikan stok
    for (const order of expiredOrders) {
        
        // A. Kembalikan Stok Produk
        if (order.order_items && order.order_items.length > 0) {
            for (const item of order.order_items) {
                // Ambil stok saat ini dulu (Simple approach without RPC)
                const { data: product } = await supabase
                    .from('products')
                    .select('stock')
                    .eq('id', item.product_id)
                    .single();

                if (product) {
                    await supabase
                        .from('products')
                        .update({ stock: product.stock + item.quantity })
                        .eq('id', item.product_id);
                }
            }
        }

        // B. Update status order jadi EXPIRED
        await supabase
            .from('orders')
            .update({ status: 'EXPIRED' })
            .eq('id', order.id);
            
        console.log(`🚫 Order ${order.id} expired & stock restored.`);
    }

  } catch (err) {
    console.error('❌ [CRON] Error in expireOrders job:', err);
  }
});