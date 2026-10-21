import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DestructionService } from './destruction.service';
import { DestructionInfrastructure } from './destruction.infrastructure';
import { DestructionController, DestructionBearerGuard } from './destruction.controller';
import { DestructionWorker } from './destruction.worker';
import { LocalDestructionInfrastructure } from './local-infrastructure';

@Module({ imports: [AuthModule], controllers: [DestructionController],
  providers: [DestructionService, DestructionInfrastructure, LocalDestructionInfrastructure, DestructionWorker, DestructionBearerGuard],
  exports: [DestructionInfrastructure] })
export class DestructionModule {}
