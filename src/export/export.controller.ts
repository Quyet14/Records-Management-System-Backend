import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ExportService } from './export.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('export')
export class ExportController {
  constructor(private service: ExportService) {}

  /**
   * Xuất Excel
   * GET /export/excel?status=stored&departmentId=...&dateFrom=...&dateTo=...
   */
  @Get('excel')
  async exportExcel(
    @Query() filter: any,
    @CurrentUser() user,
    @Res() res: Response,
  ) {
    const buffer = await this.service.exportExcel(filter, user);
    const filename = `documents_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  /**
   * Xuất PDF
   * GET /export/pdf?status=stored&departmentId=...&dateFrom=...&dateTo=...
   */
  @Get('pdf')
  async exportPdf(
    @Query() filter: any,
    @CurrentUser() user,
    @Res() res: Response,
  ) {
    const buffer = await this.service.exportPdf(filter, user);
    const filename = `documents_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
