import { Column, Entity, PrimaryGeneratedColumn, OneToMany } from 'typeorm';
import { User } from './user.entity';
import { Document } from './document.entity';

@Entity('departments')
export class Department {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, length: 255 })
  name: string;

  @OneToMany(() => User, (user) => user.department)
  users: User[];

  @OneToMany(() => Document, (doc) => doc.department)
  documents: Document[];
}
