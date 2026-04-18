// Test script to send mock alert notification
async function testAlertNotification() {
  console.log('Testing alert notification via mock API...');

  const testData = {
    to: 'test@example.com',
    alertType: 'overspending',
    campaignName: 'Test Campaign',
    currentSpend: 150,
    expectedSpend: 100,
    pacingPercent: 150,
    accountName: 'Test Account'
  };

  try {
    const response = await fetch('http://localhost:3000/api/send-alert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testData)
    });

    const result = await response.json();
    console.log('Mock alert response:', result);

    if (result.success) {
      console.log('✅ Alert notification test successful!');
      console.log('📧 Mock email would be sent to:', testData.to);
      console.log('📄 Subject: ⚠️ Overspending Alert:', testData.campaignName);
      console.log('💰 Current spend: €' + testData.currentSpend);
      console.log('🎯 Expected spend: €' + testData.expectedSpend);
      console.log('📊 Pacing: ' + testData.pacingPercent + '%');
    } else {
      console.log('❌ Alert test failed');
    }
  } catch (error) {
    console.error('❌ Test error:', error);
    console.log('💡 Make sure the development server is running: node dev-server.js');
  }
}

// Test campaigns API
async function testCampaignsAPI() {
  console.log('\nTesting campaigns API...');

  try {
    const response = await fetch('http://localhost:3000/api/meta/campaigns?account_id=act_123456789');
    const result = await response.json();

    console.log('Mock campaigns response:', result);

    if (result.success && result.campaigns.length > 0) {
      console.log('✅ Campaigns API test successful!');
      console.log('📊 Found', result.campaigns.length, 'campaign(s)');
      result.campaigns.forEach(campaign => {
        console.log('  -', campaign.name, '(€' + campaign.spend + ' spent, ' + campaign.pacing_percent + '% pacing)');
      });
    }
  } catch (error) {
    console.error('❌ Campaigns API test error:', error);
  }
}

// Run tests
async function runTests() {
  await testAlertNotification();
  await testCampaignsAPI();
  console.log('\n🎉 All tests completed!');
  console.log('🌐 Open http://localhost:3000 in your browser to test the UI');
}

runTests();