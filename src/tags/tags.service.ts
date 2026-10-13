import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tag } from '../entities/tag.entity';
import { Document } from '../entities/document.entity';
import { CreateTagDto } from './dto/create-tag.dto';

@Injectable()
export class TagsService {
  constructor(
    @InjectRepository(Tag) private tagRepo: Repository<Tag>,
    @InjectRepository(Document) private docRepo: Repository<Document>,
  ) {}

  // ─── CRUD Tags ────────────────────────────────────────────────

  findAll(): Promise<Tag[]> {
    return this.tagRepo.find({ order: { name: 'ASC' } });
  }

  async create(dto: CreateTagDto): Promise<Tag> {
    const existing = await this.tagRepo.findOne({ where: { name: dto.name } });
    if (existing) throw new BadRequestException(`Tag "${dto.name}" đã tồn tại`);
    const tag = this.tagRepo.create({ name: dto.name });
    return this.tagRepo.save(tag);
  }

  async remove(id: string): Promise<void> {
    const tag = await this.tagRepo.findOne({ where: { id } });
    if (!tag) throw new NotFoundException('Không tìm thấy tag');
    await this.tagRepo.remove(tag);
  }

  // ─── Gắn / gỡ tag cho tài liệu ───────────────────────────────

  async addTagToDocument(docId: string, tagId: string): Promise<Document> {
    const doc = await this.docRepo.findOne({
      where: { id: docId },
      relations: ['tags'],
    });
    if (!doc) throw new NotFoundException('Không tìm thấy tài liệu');

    const tag = await this.tagRepo.findOne({ where: { id: tagId } });
    if (!tag) throw new NotFoundException('Không tìm thấy tag');

    const alreadyTagged = doc.tags?.some((t) => t.id === tagId);
    if (alreadyTagged) throw new BadRequestException('Tài liệu đã có tag này');

    doc.tags = [...(doc.tags || []), tag];
    return this.docRepo.save(doc);
  }

  async removeTagFromDocument(docId: string, tagId: string): Promise<Document> {
    const doc = await this.docRepo.findOne({
      where: { id: docId },
      relations: ['tags'],
    });
    if (!doc) throw new NotFoundException('Không tìm thấy tài liệu');

    doc.tags = (doc.tags || []).filter((t) => t.id !== tagId);
    return this.docRepo.save(doc);
  }

  // ─── Tìm tài liệu theo tag ────────────────────────────────────

  async findDocumentsByTag(tagId: string): Promise<Document[]> {
    const tag = await this.tagRepo.findOne({ where: { id: tagId } });
    if (!tag) throw new NotFoundException('Không tìm thấy tag');

    return this.docRepo
      .createQueryBuilder('doc')
      .innerJoin('doc.tags', 'tag', 'tag.id = :tagId', { tagId })
      .leftJoinAndSelect('doc.uploader', 'uploader')
      .leftJoinAndSelect('doc.department', 'department')
      .leftJoinAndSelect('doc.tags', 'allTags')
      .orderBy('doc.createdAt', 'DESC')
      .getMany();
  }

  async findDocumentsByTagName(tagName: string): Promise<Document[]> {
    const normalized = tagName.toLowerCase().trim();
    return this.docRepo
      .createQueryBuilder('doc')
      .innerJoin('doc.tags', 'tag', 'tag.name = :name', { name: normalized })
      .leftJoinAndSelect('doc.uploader', 'uploader')
      .leftJoinAndSelect('doc.department', 'department')
      .leftJoinAndSelect('doc.tags', 'allTags')
      .orderBy('doc.createdAt', 'DESC')
      .getMany();
  }
}
