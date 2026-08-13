export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      activity: {
        Row: {
          created_at: string;
          details: Json;
          event_type: string;
          id: string;
          owner_id: string;
          project_id: string;
          task_id: string | null;
        };
        Insert: {
          created_at?: string;
          details?: Json;
          event_type: string;
          id?: string;
          owner_id?: string;
          project_id: string;
          task_id?: string | null;
        };
        Update: {
          created_at?: string;
          details?: Json;
          event_type?: string;
          id?: string;
          owner_id?: string;
          project_id?: string;
          task_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'activity_project_id_owner_id_fkey';
            columns: ['project_id', 'owner_id'];
            isOneToOne: false;
            referencedRelation: 'projects';
            referencedColumns: ['id', 'owner_id'];
          },
          {
            foreignKeyName: 'activity_task_id_owner_id_project_id_fkey';
            columns: ['task_id', 'owner_id', 'project_id'];
            isOneToOne: false;
            referencedRelation: 'tasks';
            referencedColumns: ['id', 'owner_id', 'project_id'];
          },
        ];
      };
      comments: {
        Row: {
          body: string;
          created_at: string;
          id: string;
          owner_id: string;
          project_id: string;
          task_id: string;
          updated_at: string;
        };
        Insert: {
          body: string;
          created_at?: string;
          id?: string;
          owner_id?: string;
          project_id: string;
          task_id: string;
          updated_at?: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          id?: string;
          owner_id?: string;
          project_id?: string;
          task_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'comments_task_id_owner_id_project_id_fkey';
            columns: ['task_id', 'owner_id', 'project_id'];
            isOneToOne: false;
            referencedRelation: 'tasks';
            referencedColumns: ['id', 'owner_id', 'project_id'];
          },
        ];
      };
      instruction_template_versions: {
        Row: {
          content: string;
          created_at: string;
          id: string;
          owner_id: string | null;
          template_id: string;
          version: number;
        };
        Insert: {
          content?: string;
          created_at?: string;
          id?: string;
          owner_id?: string | null;
          template_id: string;
          version: number;
        };
        Update: {
          content?: string;
          created_at?: string;
          id?: string;
          owner_id?: string | null;
          template_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'instruction_template_versions_template_id_fkey';
            columns: ['template_id'];
            isOneToOne: false;
            referencedRelation: 'instruction_templates';
            referencedColumns: ['id'];
          },
        ];
      };
      instruction_templates: {
        Row: {
          created_at: string;
          id: string;
          is_base: boolean;
          name: string;
          owner_id: string | null;
          provider: Database['public']['Enums']['provider_family'];
          role: Database['public']['Enums']['instruction_role'];
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_base?: boolean;
          name: string;
          owner_id?: string | null;
          provider: Database['public']['Enums']['provider_family'];
          role: Database['public']['Enums']['instruction_role'];
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_base?: boolean;
          name?: string;
          owner_id?: string | null;
          provider?: Database['public']['Enums']['provider_family'];
          role?: Database['public']['Enums']['instruction_role'];
          updated_at?: string;
        };
        Relationships: [];
      };
      project_instruction_selections: {
        Row: {
          created_at: string;
          id: string;
          owner_id: string;
          project_id: string;
          role: Database['public']['Enums']['instruction_role'];
          template_version_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          owner_id?: string;
          project_id: string;
          role: Database['public']['Enums']['instruction_role'];
          template_version_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          owner_id?: string;
          project_id?: string;
          role?: Database['public']['Enums']['instruction_role'];
          template_version_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'project_instruction_selections_project_id_owner_id_fkey';
            columns: ['project_id', 'owner_id'];
            isOneToOne: false;
            referencedRelation: 'projects';
            referencedColumns: ['id', 'owner_id'];
          },
          {
            foreignKeyName: 'project_instruction_selections_template_version_id_fkey';
            columns: ['template_version_id'];
            isOneToOne: false;
            referencedRelation: 'instruction_template_versions';
            referencedColumns: ['id'];
          },
        ];
      };
      projects: {
        Row: {
          created_at: string;
          description: string;
          id: string;
          name: string;
          owner_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          description?: string;
          id?: string;
          name: string;
          owner_id?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          description?: string;
          id?: string;
          name?: string;
          owner_id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      task_evidence: {
        Row: {
          created_at: string;
          id: string;
          kind: string;
          metadata: Json;
          owner_id: string;
          project_id: string;
          source_url: string | null;
          summary: string;
          task_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          kind: string;
          metadata?: Json;
          owner_id?: string;
          project_id: string;
          source_url?: string | null;
          summary?: string;
          task_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          kind?: string;
          metadata?: Json;
          owner_id?: string;
          project_id?: string;
          source_url?: string | null;
          summary?: string;
          task_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'task_evidence_task_id_owner_id_project_id_fkey';
            columns: ['task_id', 'owner_id', 'project_id'];
            isOneToOne: false;
            referencedRelation: 'tasks';
            referencedColumns: ['id', 'owner_id', 'project_id'];
          },
        ];
      };
      task_relations: {
        Row: {
          created_at: string;
          id: string;
          kind: Database['public']['Enums']['task_relation_kind'];
          owner_id: string;
          project_id: string;
          related_task_id: string;
          task_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          kind: Database['public']['Enums']['task_relation_kind'];
          owner_id?: string;
          project_id: string;
          related_task_id: string;
          task_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          kind?: Database['public']['Enums']['task_relation_kind'];
          owner_id?: string;
          project_id?: string;
          related_task_id?: string;
          task_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'task_relations_related_task_id_owner_id_project_id_fkey';
            columns: ['related_task_id', 'owner_id', 'project_id'];
            isOneToOne: false;
            referencedRelation: 'tasks';
            referencedColumns: ['id', 'owner_id', 'project_id'];
          },
          {
            foreignKeyName: 'task_relations_task_id_owner_id_project_id_fkey';
            columns: ['task_id', 'owner_id', 'project_id'];
            isOneToOne: false;
            referencedRelation: 'tasks';
            referencedColumns: ['id', 'owner_id', 'project_id'];
          },
        ];
      };
      tasks: {
        Row: {
          created_at: string;
          description: string;
          due_at: string | null;
          id: string;
          owner_id: string;
          priority: number;
          project_id: string;
          status: Database['public']['Enums']['task_status'];
          title: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          description?: string;
          due_at?: string | null;
          id?: string;
          owner_id?: string;
          priority?: number;
          project_id: string;
          status?: Database['public']['Enums']['task_status'];
          title: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          description?: string;
          due_at?: string | null;
          id?: string;
          owner_id?: string;
          priority?: number;
          project_id?: string;
          status?: Database['public']['Enums']['task_status'];
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tasks_project_id_owner_id_fkey';
            columns: ['project_id', 'owner_id'];
            isOneToOne: false;
            referencedRelation: 'projects';
            referencedColumns: ['id', 'owner_id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      instruction_role: 'orchestrator' | 'worker' | 'auditor';
      provider_family: 'codex' | 'claude_code' | 'kilo_code';
      task_relation_kind: 'depends_on' | 'blocks' | 'relates_to' | 'duplicates';
      task_status: 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      instruction_role: ['orchestrator', 'worker', 'auditor'],
      provider_family: ['codex', 'claude_code', 'kilo_code'],
      task_relation_kind: ['depends_on', 'blocks', 'relates_to', 'duplicates'],
      task_status: ['backlog', 'ready', 'in_progress', 'blocked', 'done', 'cancelled'],
    },
  },
} as const;
