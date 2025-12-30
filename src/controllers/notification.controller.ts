import { Request, Response } from 'express';
import { supabase } from '../config/supabase';

export class NotificationController {
  
  // Ambil semua notifikasi user
  static async getMyNotifications(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20); // Ambil 20 terakhir aja

      if (error) throw error;

      // Hitung jumlah yang belum dibaca
      const unreadCount = data.filter((n: any) => !n.is_read).length;

      res.json({ 
        success: true, 
        data: data, 
        unread_count: unreadCount 
      });

    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // Tandai sudah dibaca
  static async markAsRead(req: Request, res: Response) {
    try {
        const user = (req as any).user;
        // Update semua notif user ini jadi is_read = true
        await supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('user_id', user.id)
            .eq('is_read', false); // Cuma update yang belum dibaca

        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
  }
}