import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { assertDestructiveOpsAllowed } from '@/lib/server/destructive-ops-guard'

/**
 * POST /api/admin/delete-all-data
 * Delete ALL data (transactions + master data) except Super Admin and system data
 * SUPER ADMIN ONLY (role_level = 1)
 */
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    // Centralized environment + auth + role guard
    const guard = await assertDestructiveOpsAllowed(request, 'delete-all-data')
    if (guard.blocked) return guard.response
    // The preserved Super Admin is the verified caller from the guard. Without it nothing is deleted: the steps below
    // keep exactly this account and its organization.
    if (!guard.userId) return NextResponse.json({ success: false, error: 'Caller could not be verified' }, { status: 401 })
    const user = { id: guard.userId, email: guard.userEmail ?? null }

    const supabase = await createClient()

    console.log('🚨 DANGER ZONE: DELETE ALL DATA (Transaction + Master Data)')
    console.log('🔑 Initiated by Super Admin:', guard.userEmail)
    console.log('⚠️  Preserving: Super Admin account + Parent Organization')

    let deletedCount = 0
    const errors: string[] = []

    // ========================================
    // PHASE 1: DELETE TRANSACTION DATA
    // ========================================
    console.log('\n📦 PHASE 1: Deleting Transaction Data...')

    // 1. Delete document workflows
    const { count: docWorkflowCount } = await supabase
      .from('document_workflows' as any)
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += docWorkflowCount || 0
    console.log(`✓ Deleted ${docWorkflowCount || 0} document workflows`)

    // 2. Delete QR movements (depends on QR codes and orgs)
    const { count: qrMovementsCount } = await supabase
      .from('qr_movements')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += qrMovementsCount || 0
    console.log(`✓ Deleted ${qrMovementsCount || 0} QR movements`)

    // 3. Delete QR validation reports
    const { count: qrValidationCount } = await supabase
      .from('qr_validation_reports')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += qrValidationCount || 0
    console.log(`✓ Deleted ${qrValidationCount || 0} QR validation reports`)

    // 4. Delete QR codes (individual)
    const { count: qrCodesCount } = await supabase
      .from('qr_codes')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += qrCodesCount || 0
    console.log(`✓ Deleted ${qrCodesCount || 0} QR codes`)

    // 5. Delete QR master codes
    const { count: masterCodesCount } = await supabase
      .from('qr_master_codes')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += masterCodesCount || 0
    console.log(`✓ Deleted ${masterCodesCount || 0} QR master codes`)

    // 6. Delete QR batches
    const { count: qrBatchesCount } = await supabase
      .from('qr_batches')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += qrBatchesCount || 0
    console.log(`✓ Deleted ${qrBatchesCount || 0} QR batches`)

    // 7. Delete payments
    const { count: paymentsCount } = await supabase
      .from('payments' as any)
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += paymentsCount || 0
    console.log(`✓ Deleted ${paymentsCount || 0} payments`)

    // 8. Delete invoices
    const { count: invoicesCount } = await supabase
      .from('invoices' as any)
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += invoicesCount || 0
    console.log(`✓ Deleted ${invoicesCount || 0} invoices`)

    // 9. Delete shipments
    const { count: shipmentsCount } = await supabase
      .from('shipments' as any)
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += shipmentsCount || 0
    console.log(`✓ Deleted ${shipmentsCount || 0} shipments`)

    // 10. Delete documents
    const { count: documentsCount } = await supabase
      .from('documents')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += documentsCount || 0
    console.log(`✓ Deleted ${documentsCount || 0} documents`)

    // 11. Delete order items
    const { count: orderItemsCount } = await supabase
      .from('order_items')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += orderItemsCount || 0
    console.log(`✓ Deleted ${orderItemsCount || 0} order items`)

    // 11a. Delete journey order links (before deleting orders)
    const { count: journeyOrderLinksCount } = await supabase
      .from('journey_order_links')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += journeyOrderLinksCount || 0
    console.log(`✓ Deleted ${journeyOrderLinksCount || 0} journey order links`)

    // 12. Delete orders
    const { count: ordersCount } = await supabase
      .from('orders')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += ordersCount || 0
    console.log(`✓ Deleted ${ordersCount || 0} orders`)

    // 13. Delete consumer engagement data
    const { count: pointsCount } = await supabase
      .from('points_transactions')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += pointsCount || 0
    console.log(`✓ Deleted ${pointsCount || 0} points transactions`)

    const { count: luckyDrawEntriesCount } = await supabase
      .from('lucky_draw_entries')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += luckyDrawEntriesCount || 0
    console.log(`✓ Deleted ${luckyDrawEntriesCount || 0} lucky draw entries`)

    const { count: luckyDrawCampaignsCount } = await supabase
      .from('lucky_draw_campaigns')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += luckyDrawCampaignsCount || 0
    console.log(`✓ Deleted ${luckyDrawCampaignsCount || 0} lucky draw campaigns`)

    const { count: redeemItemsCount } = await supabase
      .from('redeem_items')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += redeemItemsCount || 0
    console.log(`✓ Deleted ${redeemItemsCount || 0} redeem items`)

    const { count: consumerActivationsCount } = await supabase
      .from('consumer_activations')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += consumerActivationsCount || 0
    console.log(`✓ Deleted ${consumerActivationsCount || 0} consumer activations`)

    const { count: consumerQrScansCount } = await supabase
      .from('consumer_qr_scans')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += consumerQrScansCount || 0
    console.log(`✓ Deleted ${consumerQrScansCount || 0} consumer QR scans`)

    console.log('✅ Phase 1 Complete - Transaction data deleted')

    // ========================================
    // PHASE 2: DELETE MASTER DATA
    // ========================================
    console.log('\n� PHASE 2: Deleting Master Data...')

    // 1. Delete document counters (depends on organizations)
    const { count: docCountersCount } = await supabase
      .from('doc_counters')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += docCountersCount || 0
    console.log(`✓ Deleted ${docCountersCount || 0} document counters`)

    // 2. Delete shop_distributors relationship (depends on shops & distributors)
    const { count: shopDistCount } = await supabase
      .from('shop_distributors')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += shopDistCount || 0
    console.log(`✓ Deleted ${shopDistCount || 0} shop-distributor relationships`)

    // 3. Delete product-related data (depends on organizations)
    const { count: productSkusCount } = await supabase
      .from('product_skus')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += productSkusCount || 0
    console.log(`✓ Deleted ${productSkusCount || 0} product SKUs`)

    const { count: productPricingCount } = await supabase
      .from('product_pricing')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += productPricingCount || 0
    console.log(`✓ Deleted ${productPricingCount || 0} product pricing records`)

    const { count: distributorProductsCount } = await supabase
      .from('distributor_products')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += distributorProductsCount || 0
    console.log(`✓ Deleted ${distributorProductsCount || 0} distributor products`)

    // 4. Delete product variants
    const { count: variantsCount } = await supabase
      .from('product_variants')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += variantsCount || 0
    console.log(`✓ Deleted ${variantsCount || 0} product variants`)

    // 4a. Delete product images (BEFORE deleting products)
    const { count: productImagesCount } = await supabase
      .from('product_images')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += productImagesCount || 0
    console.log(`✓ Deleted ${productImagesCount || 0} product images`)

    // 5. Delete products
    const { count: productsCount } = await supabase
      .from('products')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += productsCount || 0
    console.log(`✓ Deleted ${productsCount || 0} products`)

    // 6. Delete product categories
    const { count: productCategoriesCount } = await supabase
      .from('product_categories')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += productCategoriesCount || 0
    console.log(`✓ Deleted ${productCategoriesCount || 0} product categories`)

    // 7. Delete product subgroups
    const { count: productSubgroupsCount } = await supabase
      .from('product_subgroups')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += productSubgroupsCount || 0
    console.log(`✓ Deleted ${productSubgroupsCount || 0} product subgroups`)

    // 8. Delete product groups
    const { count: productGroupsCount } = await supabase
      .from('product_groups')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += productGroupsCount || 0
    console.log(`✓ Deleted ${productGroupsCount || 0} product groups`)

    // 9. Delete brands
    const { count: brandsCount } = await supabase
      .from('brands')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += brandsCount || 0
    console.log(`✓ Deleted ${brandsCount || 0} brands`)

    // 10. Delete categories
    const { count: categoriesCount } = await supabase
      .from('categories' as any)
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += categoriesCount || 0
    console.log(`✓ Deleted ${categoriesCount || 0} categories`)

    // 11. Get Super Admin's parent organization before deleting users
    const { data: superAdminUser } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single()
    
    const parentOrgId = (superAdminUser as any)?.organization_id
    console.log(`🏢 Preserving parent organization: ${parentOrgId}`)

    // 12. Delete all users from database except Super Admin
    const { count: usersCount } = await supabase
      .from('users')
      .delete({ count: 'exact' })
      .neq('id', user.id)
    
    deletedCount += usersCount || 0
    console.log(`✓ Deleted ${usersCount || 0} users from database (kept Super Admin)`)

    // 13. Delete all auth users except super@dev.com
    try {
      // Get all auth users using admin API
      const { data: { users: authUsers }, error: listError } = await supabase.auth.admin.listUsers()
      
      if (listError) {
        console.error('Error listing auth users:', listError)
        errors.push(`Failed to list auth users: ${listError.message}`)
      } else if (authUsers) {
        let authUsersDeleted = 0
        
        // Delete each user except super@dev.com
        for (const authUser of authUsers) {
          if (authUser.email !== 'super@dev.com') {
            const { error: deleteError } = await supabase.auth.admin.deleteUser(authUser.id)
            
            if (deleteError) {
              console.error(`Error deleting auth user ${authUser.email}:`, deleteError)
              errors.push(`Failed to delete auth user ${authUser.email}: ${deleteError.message}`)
            } else {
              authUsersDeleted++
            }
          }
        }
        
        console.log(`✓ Deleted ${authUsersDeleted} auth users (kept super@dev.com)`)
      }
    } catch (authError: any) {
      console.error('Error during auth user deletion:', authError)
      errors.push(`Auth user deletion error: ${authError.message}`)
    }

    // 14. Delete distributor relationships (BEFORE deleting organizations)
    const { count: distributorRelationshipsCount } = await supabase
      .from('distributor_relationships' as any)
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += distributorRelationshipsCount || 0
    console.log(`✓ Deleted ${distributorRelationshipsCount || 0} distributor relationships`)

    // 15. Delete inventory records (BEFORE deleting organizations)
    const { count: inventoryCount } = await supabase
      .from('inventory' as any)
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += inventoryCount || 0
    console.log(`✓ Deleted ${inventoryCount || 0} inventory records`)

    // 16. DELETE ALL ORGANIZATIONS (Shops, Distributors, Manufacturers, Warehouses)
    // First pass: Delete organizations with parent_org_id (child orgs - shops, branches, etc.)
    const { count: childOrgsCount } = await supabase
      .from('organizations')
      .delete({ count: 'exact' })
      .not('parent_org_id', 'is', null)
      .neq('id', parentOrgId || '00000000-0000-0000-0000-000000000000')
    
    deletedCount += childOrgsCount || 0
    console.log(`✓ Deleted ${childOrgsCount || 0} child organizations (shops, branches, etc.)`)

    // Second pass: Delete ALL remaining organizations EXCEPT the Super Admin's parent org
    // This catches manufacturers, distributors, warehouses that are root-level
    const { count: allOtherOrgsCount } = await supabase
      .from('organizations')
      .delete({ count: 'exact' })
      .neq('id', parentOrgId || '00000000-0000-0000-0000-000000000000')
    
    deletedCount += allOtherOrgsCount || 0
    console.log(`✓ Deleted ${allOtherOrgsCount || 0} organizations (manufacturers, distributors, warehouses - kept parent HQ only)`)

    // 17. Delete journey configurations (AFTER deleting organizations since it references org_id)
    const { count: journeyConfigsCount } = await supabase
      .from('journey_configurations')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000')
    
    deletedCount += journeyConfigsCount || 0
    console.log(`✓ Deleted ${journeyConfigsCount || 0} journey configurations`)

    console.log('✅ Phase 2 Complete - Master data deleted (parent org preserved)')    // ========================================
    // PHASE 3: DELETE STORAGE FILES
    // ========================================
    console.log('\n📦 PHASE 3: Deleting Storage Files...')

    let filesDeleted = 0

    try {
      // Delete QR code files
      const { data: qrFiles } = await supabase.storage
        .from('qr-codes')
        .list()
      
      if (qrFiles && qrFiles.length > 0) {
        const filePaths = qrFiles.map(file => file.name)
        await supabase.storage.from('qr-codes').remove(filePaths)
        filesDeleted += filePaths.length
        console.log(`✓ Deleted ${filePaths.length} QR code files`)
      }
    } catch (error) {
      console.error('QR codes storage error:', error)
    }

    try {
      // Delete document files
      const { data: docFiles } = await supabase.storage
        .from('documents')
        .list()
      
      if (docFiles && docFiles.length > 0) {
        const filePaths = docFiles.map(file => file.name)
        await supabase.storage.from('documents').remove(filePaths)
        filesDeleted += filePaths.length
        console.log(`✓ Deleted ${filePaths.length} document files`)
      }
    } catch (error) {
      console.error('Documents storage error:', error)
    }

    try {
      // Delete avatars (user avatars and organization logos)
      // List all folders in avatars bucket
      const { data: avatarFolders } = await supabase.storage
        .from('avatars')
        .list()
      
      if (avatarFolders && avatarFolders.length > 0) {
        for (const folder of avatarFolders) {
          // Don't delete Super Admin's avatar folder
          if (folder.name !== user.id) {
            const { data: files } = await supabase.storage
              .from('avatars')
              .list(folder.name)
            
            if (files && files.length > 0) {
              const filePaths = files.map(file => `${folder.name}/${file.name}`)
              await supabase.storage.from('avatars').remove(filePaths)
              filesDeleted += filePaths.length
            }
          }
        }
        console.log(`✓ Deleted avatar and logo files (kept Super Admin avatar)`)
      }
    } catch (error) {
      console.error('Avatars storage error:', error)
    }

    try {
      // Delete product images
      const { data: productImageFolders } = await supabase.storage
        .from('product-images')
        .list()
      
      if (productImageFolders && productImageFolders.length > 0) {
        for (const folder of productImageFolders) {
          const { data: files } = await supabase.storage
            .from('product-images')
            .list(folder.name)
          
          if (files && files.length > 0) {
            const filePaths = files.map(file => `${folder.name}/${file.name}`)
            await supabase.storage.from('product-images').remove(filePaths)
            filesDeleted += filePaths.length
          }
        }
        console.log(`✓ Deleted product image files`)
      }
    } catch (error) {
      console.error('Product images storage error:', error)
    }

    console.log(`✅ Phase 3 Complete - ${filesDeleted} storage files deleted`)

    // ========================================
    // FINAL SUMMARY
    // ========================================
    const totalDeleted = deletedCount + filesDeleted

    console.log('\n' + '='.repeat(60))
    console.log('🎉 DANGER ZONE DELETION COMPLETE')
    console.log('='.repeat(60))
    console.log(`📊 Total Database Records Deleted: ${deletedCount}`)
    console.log(`📁 Total Storage Files Deleted: ${filesDeleted}`)
    console.log(`🔢 Grand Total: ${totalDeleted}`)
    console.log(`✅ Super Admin Preserved: ${user.email}`)
    console.log(`✅ Parent Organization Preserved`)
    if (errors.length > 0) {
      console.log(`⚠️ Errors encountered: ${errors.length}`)
      errors.forEach(err => console.log(`  - ${err}`))
    }
    console.log('='.repeat(60))

    return NextResponse.json({
      success: true,
      deleted_count: totalDeleted,
      database_records: deletedCount,
      storage_files: filesDeleted,
      preserved_user: user.email,
      preserved_parent_org: true,
      errors: errors.length > 0 ? errors : undefined,
      message: errors.length > 0 
        ? 'Deletion completed with some errors. Parent organization and Super Admin preserved.'
        : 'All transaction and master data deleted successfully. Parent organization and Super Admin preserved.'
    })

  } catch (error: any) {
    console.error('❌ CRITICAL ERROR during full deletion:', error)
    return NextResponse.json(
      { error: 'Failed to delete all data', details: error.message },
      { status: 500 }
    )
  }
}
