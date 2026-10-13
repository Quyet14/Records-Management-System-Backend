import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Department } from '../entities/department.entity';

@Injectable()
export class DepartmentsService {
  constructor(
    @InjectRepository(Department) private repo: Repository<Department>,
  ) {}

  findAll() {
    return this.repo.find({ order: { name: 'ASC' } });
  }

  create(name: string) {
    const dept = this.repo.create({ name });
    return this.repo.save(dept);
  }
}
