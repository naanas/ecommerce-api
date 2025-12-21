import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase';

export class AuthController {
  static async register(req: Request, res: Response) {
    try {
      // Tambahkan phone di input
      const { email, password, name, phone, role } = req.body;

      if (!['SELLER', 'BUYER'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const { data, error } = await supabase
        .from('users')
        .insert({ 
          email, 
          password_hash: hashedPassword, 
          name, 
          phone, // Simpan ke DB
          role 
        })
        .select()
        .single();

      if (error) throw error;

      res.status(201).json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body;

      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('email', email)
        .single();

      if (error || !user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Masukkan phone ke dalam payload Token
      const token = jwt.sign(
        { 
          id: user.id, 
          email: user.email, 
          name: user.name, 
          phone: user.phone, // Include phone disini
          role: user.role 
        },
        process.env.JWT_SECRET!,
        { expiresIn: '1d' }
      );

      res.json({
        success: true,
        data: { 
          token, 
          user: { 
            id: user.id, 
            name: user.name, 
            phone: user.phone, 
            role: user.role 
          } 
        }
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}